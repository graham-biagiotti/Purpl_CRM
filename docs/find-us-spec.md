# Where to Find Us — Build Spec (approved for map; not yet built)

Public stockist locator at **pbfwholesale.com/find-us**, linkable from both Wix
sites with per-brand views. Map-first. Data lives in the CRM; the public page
exposes only name/address/coords/brands.

## 1. Data model

**Account-backed listings** (auto-sync with account lifecycle):
- `account.stockistListed` (bool) — checkbox "List on Where to Find Us" in the
  account editor.
- `account.stockistBrands` (array: 'purpl','lf') — two tag checkboxes next to
  it. Pre-suggested from evidence at first open: purpl if the account has any
  purpl/combined invoices, lf if any LF/combined invoices. Editable.
- Locations: the account's existing `locs[]` (multi-location supported); falls
  back to top-level address/lat/lng. Coordinates come from the existing
  geocoder.
- Listing shows only while `status !== 'inactive'` — churned stores drop off
  automatically.

**Manual locations** (chain doors, farm stand, anything without its own
account): new collection `stockist_locations`:
`{ id, name, address, city, state, lat, lng, brands[], active, note, accountId? }`
- Managed in a "Where to Find Us" card (Settings page): add/edit/deactivate
  rows; addresses geocoded on save via the existing geocoder path.
- `accountId` optional back-reference (e.g. Price Chopper parent) — internal
  only, never exposed.
- Chain-door policy is operational, not code: owner adds only doors they want
  advertised (recommended: doors confirmed on-shelf).

## 2. Public cloud function

`getStockists` (onCall, public, no auth — same pattern as getPortalConfig):
- Merges: accounts (`stockistListed && status !== 'inactive'`, one entry per
  geocoded location) + `stockist_locations` (`active !== false`).
- Returns ONLY: `{ name, address, lat, lng, brands }` per entry, plus a count.
- Nothing else is reachable: no emails, tokens, pricing, ids.
- Skips entries with no coordinates (they'd break the map); count of skipped
  returned for the CRM manager card to surface ("2 listings missing pins").

## 3. Public page — public-wholesale/find-us.html (+ /find-us rewrite)

- Consumer styling: both brand logos (self-hosted), no wholesale nav, no
  portal/password references anywhere.
- **Map on top** (Google Maps JS, the referrer-restricted key): pins colored
  purpl `#8B5FBF` / LF `#4a7c59` / both = purpl pin with dual badge in the info
  window. Pin click → info window (name, address, brands, Directions link) and
  highlights the matching card.
- **List below**: cards grouped by state (NH/MA/ME/VT/other), each card = name,
  full address, brand chips, "Directions →" (plain Google Maps link, no API).
- **Headline**: "Available at N stores across New England" — N computed live.
- **Brand filter**: chips (All / purpl / Lavender Fields) + URL param:
  - `?brand=purpl` → purpl pins/cards only, purpl-accented header
  - `?brand=lf` → LF only, LF-accented header
  - bare → all. Chips update the URL so links stay shareable.
- Mobile: map fixed-height on top, list scrolls; cards full-width.
- Graceful degradation: if Maps JS fails to load (key restriction typo, ad
  blocker), the list still renders — map is enhancement, list is the product.

## 4. Wix integration

Plain links/buttons on each site (no embed, no Wix code):
- drinkpurpl.com → `https://pbfwholesale.com/find-us?brand=purpl`
- pumpkinblossomfarm.com → `https://pbfwholesale.com/find-us?brand=lf`

## 5. Build order (small commits, each verified)

1. Account checkbox + brand tags + save wiring (+ evidence-based suggestion).
2. `stockist_locations` manager card in Settings (+ geocode on save).
3. `getStockists` function — with an adversarial check that the response can
   never include a non-whitelisted field.
4. `find-us.html` + rewrite: list + filter + headline (launchable without map).
5. Map layer on top of the same data.
6. Seed: pre-check all ACTIVE accounts with evidence-based brand tags (owner
   prunes) — recommended over starting empty; final call at build time.

**Owner prerequisites:** restrict the Maps key to purpl-crm.web.app +
pbfwholesale.com (already on the open-tasks list) · add the two Wix buttons
after launch · prune/seed listing checkboxes.

## 6. Explicitly out of scope

Store hours/phone (rot risk — Google's job via the Directions link) · search/
radius filtering (list is small) · analytics · SEO work beyond a title/meta
description · per-door inventory ("in stock" claims rot instantly).
