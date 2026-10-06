# purpl CRM test arsenal

Regression suites for every wave since v223. These ran from an ephemeral
scratchpad until 2026-10-06, when a container wipe destroyed the originals —
everything reconstructable was rebuilt and committed HERE so the arsenal is
now versioned with the code it protects. Nothing in tests/ is deployed
(firebase.json ships only public/ and public-wholesale/).

## Static backtests — `node tests/backtests/<file>.js`
No network needed. Each suite slices REAL functions out of public/app.js /
db.js and runs them against fixtures; structural scans are comment-aware.

| Suite | Covers | Assertions |
|---|---|---|
| wave10 | v231/232 multi-user data layer: dirty-doc saves, config shadow, deferred-snapshot drain, in-flight guards, gate+fuzz regressions G1-G6 | 66 |
| wave11 | v234 combined-invoice misc rows: create/edit money matrix, round-trip duplication guards, cent-exact money, downstream parity, XSS | 51 |
| wave12 | v235 date-range filters + KPI harmonization + LF fixes, gate regressions G1-G7 (LF twin fields, paid-family inference, range corners) | 40 |
| wave13 | v236 BS1 sweep fixes: readyToSend heal, counter stripping (_cfgValue), stuck-key redrive, prefill-gated override | 18 |
| wave14 | v237 follow-up Done/Change on cards + uncapped overdue, full lifecycle dynamics | 16 |
| wave15 | v238 TS1 resilience: listener terminal-death resubscribe + "Live sync lost" surface, field-app hardening (role gate / persistence warning / unsent-age bar), places loader retry, nav() markClean | 52 |
| reminder | dashboard invoice-reminder flow end to end: queue rules, send path, stamps, email HTML, failure fallback | 45 |

LOST in the wipe (built in earlier sessions, sources unrecoverable):
wave1-wave8, wave2b, removestop (~327 assertions covering v223-v230: clearRoute
defusal, year-end export, projections/radar, reports rebuild, settings/field-log
waves, combined discounts, invoice numbering, reminder email+logo, dialog
engine, rows/totals/undo/skin). Their most money-critical invariants were
re-asserted by later suites (wave10-14 + emulator), but the v223-v230 UI/flow
specifics are uncovered until rebuilt. Rebuild opportunistically when touching
those areas.

## Emulator suites — need the Firestore emulator
```
cd tests/emu && npm install        # once per machine
nohup ./node_modules/.bin/firebase emulators:start --only firestore --project demo-purpl > /tmp/emu.log 2>&1 &
node mu-tests.js                   # 30 scenarios, two REAL clients, M1-M4 proofs
node bs1-probe.js                  # BS1 HIGHs: heal-loop dead, counter survives
node fuzz-tests.js [seed]          # 400-op randomized two-user fuzz, ownership oracle
node probe1_offline_midsave.js     # transport-sweep probes (harness-transport.js)
node probe2_kill_emulator.js
node probe3_txn_transport.js
node probe4_listener_death.js      # historical: demonstrated the pre-TS1 bug
node ts1-probe.js                  # TS1 regression: probe4 inverted into a HARD
                                   # assertion (deny→allow cycle must recover).
                                   # Restarts the emulator twice — run it LAST,
                                   # then restart the emulator for other suites.
```
harness.js = the full two-client harness (compat adapter over the modular SDK,
loads the REAL public/db.js; override with env DB_SRC). harness-transport.js =
the transport sweep's minimal variant used by probe1-4. The fuzz convergence
assertion can flake on its settle window — mostly on the first run after a
cold emulator start, occasionally later (verified environmental in the TS1
wave: the same seed flaked identically against old and new db.js). Re-run
before believing a failure; a REAL regression fails consistently.

## Doctrine
Every wave: backtests green → adversarial gate agent → fixes → gate verify →
commit. Suites are contracts: when a wave deliberately changes behavior, update
the assertion WITH a comment naming the wave, never delete it silently.
