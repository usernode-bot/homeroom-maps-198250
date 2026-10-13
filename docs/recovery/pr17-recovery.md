# PR #17 recovery: saved places compatibility and the 67 check failures

An independent recovery audit of PR #17 ("Full social saved places lists", by
Evan). It is **not** a roadmap phase.

**This change does not fix PR #17.** It contains this report, a regression
test, and a patch (`pr17-recovery.patch`) that someone with approval can apply
to PR #17's branch or to a replacement PR. Evan's branch
(`dev/evan-1790853581796`) was not edited, merged or pushed. No PR was opened.

Audited on 2026-10-12.

## 1. Baseline

| Item | Value |
| --- | --- |
| PR #17 head | `039084b9967aea4b22a7f59a58418851d167a44f` ("Saved lists: migrate Phase 7 tables instead of colliding with them"), branch `dev/evan-1790853581796` |
| Moved since 039084b? | No. `refs/pull/17/head` and the branch both still point at it. |
| Base | `5a678b419899b8615083b4e0b025488e720d0820` (Phase 12F). GitHub's merge ref `refs/pull/17/merge` = `73c31e1` has parents 5a678b4 and 039084b. This is also the merge-base with main. |
| Current main | `479d169b697adca60de1b0d50e8fde6996400821`, 9 commits ahead of the base |
| Conflicts with main | Yes, one hunk in `server.js` (`/api/config`): the PR renames `placesApi` to `places`, and main adds `routing: offlineRouting`. `dapp.json` and both locale files merge cleanly. |
| Declared app checks | PR head: 66. Main: 70. |

### Evidence that could not be obtained

- **The platform's check results and logs for PR #17.** The proposal read
  returned `insufficient_scope`, so the reported "67 of 69 failed" could not be
  re-read. The breakdown below is reproduced locally. Mapping 67 onto 66
  declared checks plus the free "no console errors" check, with 2 passing
  non-browser checks (most likely the test suite and the build), is an
  inference, not a read log.
- **The staging preview**, its logs and its database.
- **The original Change #17 session.** Not accessed, as instructed.
- **Production's real Phase 7 row counts.** The migration tests use synthetic
  Phase 7 data in the exact Phase 7 schema.

## 2. Failure inventory, by verified root cause

### How the checks were reproduced

- Postgres 17 throwaway cluster.
- RS256 test key, with `USERNODE_ENV=staging` so the seeds run.
- Every `dapp.json` check run in Playwright Chromium at 1280×800, using the
  check's own selector and text.
- Locally only, the platform-hosted `/usernode-*` assets return 503 and the
  unbuilt `/tailwind.css` returns 401. This is the same on main.

### Results

| Tree | Browser checks passed | Failed |
| --- | --- | --- |
| main 479d169 | 64 / 70 | 6 (ENV) |
| PR head 039084b | 0 / 66 | 66. Every one logs `pageerror: The requested module './saved.js' does not provide an export named 'createSavedPlacesService'` |
| 039084b + patch | 62 / 66 | 4 (ENV) |
| 039084b synced with main + patch (Path A) | 70 / 76 | 6 (ENV, the same 6 as main) |

### Root causes

| Cause | Checks it explains | Proof |
| --- | --- | --- |
| **RC1. Client import contract broken.** The PR rewrote `public/js/services/saved.js` and removed `createSavedPlacesService`. Phase 7's `public/js/services/saved-places.js` (and `components/place/save-button.js`) survived the sync unchanged and still import it. `screens/home.js` imports `saved-places.js`, and `app.js` imports `home.js`, so the whole browser module graph fails to link. | All 66 declared checks, plus "loads with no console errors" | The browser run above. In Node, `import('public/js/app.js')` throws the same SyntaxError on 039084b. No unit test imported those modules, which is why all 641 passed. |
| **RC2. Removed endpoints still called.** The PR removed `/api/saved/places*`. The assistant's save confirm (`home.js` `confirmWrite`) still posted there. The PR's lists had no `system_key`, so `listRef: 'favorites'` could not resolve. The `save_place` tool schema did not ask for coordinates, which a saved item requires. | No declared check (the demo confirm button does nothing); a runtime bug | `POST /api/saved/places` → 404 on a booted PR server |
| **RC3. Phase 7 Saved checks against the PR's screen.** The host marker was `data-saved-screen`, not `data-saved-host`. The "Nothing saved yet" empty state was gone. `?list=favorites` was treated as a numeric id. | `saved.lists`, "Saved places screen shows an honest empty state", "A default saved list opens" | With only RC1 stubbed, these 3 fail with no console or network error. They pass on main. |
| **ENV. No map tiles in the sandbox.** | `home.map`, Traffic control, Traffic legend, Weather control (and the 3D checks on main) | The same checks fail on main in the sandbox. Not attributed to PR #17. |
| **RC4. Migration error "owner_id".** | None at 039084b | Running the PR's plain `SCHEMA_SQL` over Phase 7 tables reproduces `column "owner_id" does not exist`. 039084b's `migrate()` moves the Phase 7 tables aside first, so it boots on old and fresh databases. |
| **RC5. `get_saved_places` lost the place id.** The PR's `listPlaces` returned `id: null`. | No check | A test against a real database |
| **Migration audit findings** (see section 4) | No check | Tests against a real database |

Also verified and found correct:

- server bootstrap and `/api/saved` router registration;
- `migrate()` runs before `seedStaging()`;
- `/api/config` and `/api/me`;
- the profile and assistant wiring;
- the staging seeds (lists 900001 and 900002, item 900101, comments);
- i18n parity.

## 3. What the patch changes (`pr17-recovery.patch`, 4 commits on 039084b)

| Commit | Files | Change | Fixes |
| --- | --- | --- | --- |
| 1 | `public/js/screens/home.js`, `public/js/services/assistant.js` (comment), `README.md`, `dapp.json` (impact list), both locales; deletes `public/js/services/saved-places.js` and `public/js/components/place/save-button.js`; adds `tests/client-module-graph.test.js` | The assistant's save confirm calls `addPlace(listRef \|\| 'favorites', placeToSnapshot(place))` from `services/saved.js`. A place without coordinates is refused with a new notice, `assistant.saveNeedsLocation`, instead of a request. The two deleted modules had no other importers and called only removed routes. | RC1, RC2 |
| 2 | `saved/model.js`, `saved/store.js`, `assistant/actions.js` and tests | Adds `saved_lists.system_key` (`ADD COLUMN IF NOT EXISTS`) with a partial unique index per owner, set on the four defaults. `GET /lists/:id` and `POST /lists/:id/items` accept the four slugs and resolve them among the viewer's own lists only, after ensuring the defaults. Cards carry `systemKey`. The `save_place` schema requires `lat` and `lng`. | RC2, RC3 |
| 3 | `public/js/screens/saved.js` | The host also carries `data-saved-host`. "Your lists" shows the existing "Nothing saved yet" empty state when every list is empty. The list detail shows its description when there is one. | RC3 |
| 4 | `saved/store.js` and tests | Adds `saved_lists.description` and `saved_list_items.place_id` (additive). `copyPhase7` copies descriptions, slugs and place ids. It ignores a Phase 7 membership that put one person's place in another person's list; that place goes to its owner's "Saved places" list. Skipped rows are counted by reason in the boot log. `addItem` and suggestion accept store the place id, and `listPlaces` returns it. | RC5, migration audit |

No `server.js` change, no new endpoint, no dropped table, no deleted row.

### Unchanged on purpose

- **Share-key comments.** A share key still lets a reader comment (Evan's
  design). It is pending a decision (question 3).

## 4. Migration preservation and rollback

All results come from tests against a real Postgres database, in
`tests/saved.phase7-migration.postgres.test.js`. Results are on 039084b +
patch.

| Aspect | Result |
| --- | --- |
| Old Phase 7 database | Boots. Every list keeps its id, name, description and default slug, and is private. Complete places become items with their real place id. Places in no list go to a private "Saved places" list. |
| Fresh database | Boots with the new tables only, and no `*_phase7` tables. A slug works on the first visit. |
| Idempotency | A second boot copies nothing. |
| Advisory lock | Two boots at once copy exactly once. |
| Transaction rollback | A blocked rename (a leftover `saved_places_phase7`) fails the whole migration. `saved_lists` keeps its Phase 7 shape and rows. |
| Renames, indexes, sequences, foreign keys | Primary keys and the list id sequence move with the Phase 7 tables. The new sequence continues past the highest copied id. Phase 7 foreign keys follow the renamed tables. |
| Descriptions | Copied. |
| Places without coordinates or a name | Not copied (a list item needs both). They stay in `saved_places_phase7` and are counted in the log. |
| Places in no list | Copied into "Saved places". |
| Owner ids and usernames | Owner ids are kept. Phase 7 stored no usernames, so the id stands in until the owner edits the list. Copied lists are private, so nobody else sees it. |
| Cross-owner memberships | Never copied into the other person's list. |
| Duplicates | Two Phase 7 ids that map to the same place in one list are copied once and counted. |
| `*_phase7` tables | Kept and `staging:private`. All rows are intact (asserted). |
| Going back to main after migrating | Not possible as is. Main's schema fails with `column "system_key" does not exist` on the moved tables. See question 2. |

### Decisions that would delete or rewrite data (not implemented; approval needed)

1. **Places without coordinates or a name.** Options:
   - **(a) Keep them archived in `saved_places_phase7` and count them.** This
     is the patch's behaviour.
   - **(b) Allow items without coordinates.** This is a schema and UI change to
     Evan's feature.
   - **(c) Invent a placeholder name.** Not recommended: CLAUDE.md forbids
     fabricating place data.
2. **Rolling back after the move.** Going back means a reverse migration:
   rename the new tables away and the `*_phase7` tables back. Lists and items
   created after the move would not carry back unless they are copied in
   reverse, which loses suggestions, comments, visibility and notes. Only a
   down-migration written and reviewed separately should do this, with a
   snapshot taken before release. It is not part of the patch.
3. **Dropping the `*_phase7` tables.** This is out of scope. It needs its own
   approval after production has been verified.

## 5. Test totals

| Suite | Before | After |
| --- | --- | --- |
| PR head, with Postgres | 641 executed: 641 pass, 0 fail, 0 skip | 039084b + patch: 651 executed: 651 pass, 0 fail, 0 skip |
| PR head, no database | 641: 579 pass, 0 fail, 62 skipped | 651: 582 pass, 0 fail, 69 skipped |
| New tests run against unpatched 039084b | — | 7 fail as intended: the module graph; the default-list slugs over HTTP; slug and place id after a Phase 7 copy; descriptions and cross-owner memberships; the fresh-database slug; the model's slugs; the `save_place` schema. The share-key, concurrent-boot and rollback tests pass on both trees: they pin behaviour that was already correct. |
| Path A (039084b synced with main, conflict resolved, patch applied), with Postgres | — | 741 executed: 741 pass, 0 fail, 0 skip |
| This branch (main + module-graph test), with Postgres | main: 708 pass | 709: 709 pass, 0 fail, 0 skip (no database: 648 pass, 61 skipped) |
| Browser checks, local | PR head 0/66; main 64/70 | patch 62/66; Path A 70/76. Every failure is an ENV map-tile check that also fails on main locally. |
| Platform/staging checks for the patched PR | **Blocked**: no access to PR #17's results and no staging build of the patch | Run once the patch is on a branch the platform builds |

## 6. Integration plan (review first; nothing here has been done)

1. Reviewers approve the patch and answer the three questions above, plus
   question 3: should share keys stop allowing comments?
2. **Path A (PR #17 stays open).** Someone with access to
   `dev/evan-1790853581796`:
   - merges main;
   - resolves the one `server.js` hunk as
     `placeProvider: places.activeProviderName(),` and
     `offline: { ...offline, search: offlineSearch, routing: offlineRouting },`;
   - runs `git am docs/recovery/pr17-recovery.patch`;
   - pushes and lets the checks run.

   This exact sequence was rehearsed in a scratch clone: 741/741 tests and
   70/76 local browser checks, with only the ENV failures.
3. **Path B (Change #17 closed).** Only after explicit approval, open a
   replacement PR from 039084b with the same steps, crediting Evan and linking
   #17 and issue #15.
4. **Before production.** Decide the rollback question and snapshot
   `saved_lists`, `saved_places` and `saved_list_items`.

## 7. Noticed and left alone

- Rows created by an earlier PR #17 staging build (default lists with no
  `system_key`) are not backfilled. Guessing a slug from a name could mislabel
  a renamed custom list. Staging is re-copied from production, which has never
  run PR #17.
- A boot crashes if `*_phase7` tables already exist while `saved_lists` is
  still in Phase 7 shape. It is atomic, but fixing it means choosing which copy
  wins.
- The PR makes the saved tables `staging:private`, against main's CLAUDE.md
  note. That is Evan's product decision and is internally consistent.
