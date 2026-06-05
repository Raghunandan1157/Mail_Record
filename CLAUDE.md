# Mail_Record — Project & Multi-Copy Port Guide

This app is deployed for **4 companies**. This folder is **MAIN** (the source of truth).
When a feature is built/changed in MAIN, it must be **ported** to the 3 company copies —
but each copy has company-specific config that must NOT be overwritten.

## The 4 copies

| Name | Path | Git remote | Data layer |
|------|------|-----------|-----------|
| **MAIN** (source) | `/Users/raghunandanmali/Desktop/Mail_Record` | `Raghunandan1157/Mail_Record` | **Direct Supabase** (`SB='https://...supabase.co'` + anon `SK`) |
| LMCS | `.../December Performance/new - DEc _ Per/OD Report/Name/LMCS/LMCS_Mail_Record` | `Raghunandan1157/LMCS_Mail_Record` | **`/api` proxy** (`SB='/api'`, `SK=''`) |
| NVSSN | `.../Name/NVSSN/NVSSN_Mail_Record` | `Raghunandan1157/NVSSN_Mail_Record` | **`/api` proxy** |
| CFSPL | `.../Name/CFSPL/CFSPL_Mail_Record` | `Raghunandan1157/CFSPL_Mail_Record` | **`/api` proxy** |

> The 3 copies are an **older/smaller baseline** than MAIN and lag on features.
> LMCS ≈ NVSSN (nearly identical). **CFSPL diverges most** (~140 lines) — extra care.

## The one big architectural difference

- **MAIN** talks **directly to Supabase**.
- **All 3 copies** route through a **`/api` proxy** (`const SB = '/api'`, `const SK = ''`).
- Both define the same fetch helpers — `sbGet` / `sbGetAll` / `sbPost` / `sbPatch` — which
  close over the module-level `SB` + `H`. **So feature function bodies port VERBATIM** — they
  only call the helpers; no per-call URL rewriting is needed. The copies' helpers already
  resolve to `/api/rest/v1/<table>?...` automatically.

## CONFIG GUARDRAILS — never overwrite these when porting

Per-copy values that legitimately differ. A port must leave them **byte-identical**:

- `const SB = '/api';` and `const SK = '';` and the `H` headers object.
  **Never paste MAIN's `SB='https://...supabase.co'` or its anon JWT (`eyJ...`) into a copy.**
- `DOC_CATEGORIES` — differs per company:
  - LMCS / CFSPL: `Printing, IT related, Assets, Admin, Insurance - Customer, ...`
  - NVSSN: `vouchers, vochers comments, bank statments and documents, ...`
    (**deliberate misspellings — keep them**)
- `PARTICULAR_OPTIONS` (LMCS, CFSPL) and `DEPT_OPTIONS` (NVSSN, CFSPL).
- **CFSPL only:** the dept list is ALSO hardcoded as `<option>`s in the Outward form
  (~lines 200–210) and Inward form (~314–324) — **preserve all three places**.
- Admin identities (HO/CO names), `admin_otp` from `app_config` (DB-driven), FY logic
  (April start), session/storage keys (`sr_*`, `mr_*`), view-mode machinery.

## Standard port process (proven, use this every time)

1. **Build/finish the change in MAIN first.** Commit it on `master`.
2. **Identify the delta** — the new functions, markup blocks, nav/wiring, and any
   `sbGet`→`sbGetAll` swaps. Capture exact MAIN line ranges (source of truth).
3. **Per copy, on its own branch:** `git checkout -b feature/<name>` in each copy dir.
4. **Paste feature blocks verbatim** at copy-local anchors (find by code landmark, NOT by
   MAIN line numbers — copies are shorter). Add `adminAllRecords` to the existing
   `let outRecords, inRecords` line if a new admin loader needs it.
5. **Swap `sbGet`→`sbGetAll` only at admin FY-wide, no-location call sites**
   (`loadAdminData`, `renderAdminDailyReport`, `exportDailyReport` FY-seq). Leave
   location-scoped (`location=eq.`) and single-day (`date=eq.`) calls as `sbGet`.
6. **Verify before commit:** `git diff`; confirm `SB='/api'`/`SK=''` untouched, no new
   `supabase`/`eyJ`, config lists unchanged, new IDs/functions each defined once, deps
   exist (`esc`, `fmtDate`, `getCurrentFY`, `XLSX`), backticks/braces balanced.
7. **Commit + push the feature branch.** Open a PR per repo; merge after smoke-test.

## Pagination note (`sbGetAll`)

`sbGetAll` loops PostgREST `Range` headers until drained (admin-wide queries can exceed
1000 rows). The copies ship a **hardened** version with a `MAX_PAGES` ceiling + repeated-
first-row guard, so it **cannot infinite-loop** even if the `/api` proxy strips `Range`.
**Open question to verify per copy:** does `/api` forward `Range`/`Range-Unit`? If not,
admin totals cap at ~1000 (safe but possibly undercount) — adapt the fetch shape then.

## Known per-copy gaps

- Copies have **no `audit.html`** and no auditor login → the auditor flow / redirect guard
  is **out of scope** unless those files are also ported.
- Copies likely have **no `stock_entries` table** yet → the Stationary tab in branch detail
  degrades gracefully ("No stationary data"); no crash. Provision the table to populate it.

## History

- 2026-06-05: Ported MAIN's **admin → Branch view + Mail↔Stationary module switch +
  per-branch XLSX download + `sbGetAll` pagination** to LMCS/NVSSN/CFSPL on branch
  `feature/port-main-branchview` (+~507/-5 each). All audited PASS, config preserved.
