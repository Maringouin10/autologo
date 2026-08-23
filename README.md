# 🏷️ AutoLogo

Self-hosted web app to stamp a logo onto a 3D-printable model and export a
**multi-object 3MF** — the base and the logo are kept as **separate objects**
so a slicer (PrusaSlicer, Bambu Studio, OrcaSlicer…) can assign each its own
filament/color for multi-material printing.

Runs entirely in one Docker container; nothing is uploaded anywhere else. It
does three things:

- **The public gallery** (`/`, no login): every published product, as a
  clickable grid — the storefront customers land on.
- **The vendor platform** (`/admin` → `/o/<product>`): you (the vendor) upload
  a multi-part assembly once, mark exactly which piece(s)/face(s) a customer
  is allowed to put a logo on and with what print settings, and publish it.
  Customers open the product from the gallery (or its direct link) — no
  account, no password — place their logo on the spot(s) you approved, and
  submit; you get back a 3MF (the customized piece, or the whole assembly)
  plus a unique order code to match against wherever you actually take the
  order/payment.
- **The plain tool** (`/tool`, password-protected): upload any single-part
  3D model + an SVG logo, position it, export. Good for one-off jobs that
  don't need a product page at all.

## Quick start

```bash
git clone https://github.com/Maringouin10/autologo && cd autologo
cp .env.example .env   # set DASHBOARD_PASSWORD / SECRET_KEY (or leave blank for no login)
docker compose up -d --build
```

Open **http://localhost:8010** for the public gallery, **/admin** to manage
products, or **/tool** for the plain single-model tool.

## The vendor platform

1. **`/admin` → + Nouveau produit.** Upload a multi-part **3MF** assembly
   (STL/OBJ work too but won't have separate parts). The whole assembly loads
   in one viewer — the part under your click is resolved automatically, so
   clicking behaves exactly like the plain tool even though it's several
   parts glued together.
2. **Click a flat face** on the piece you want customizable, name the zone,
   set **mode** (relief/gravé) and **depth/anchor** — these are locked for
   customers, exactly so you keep control of print cost/waste (a purge tower
   for multi-material is not free). Repeat for more zones/pieces if you want
   more than one customizable spot; most products just need one.
3. **Publish**, choosing whether customers' downloads (and yours) contain
   the **whole assembly** or **just the customized piece(s)**. You get a
   public link (`/o/<product_id>`) to send customers, and a product page
   listing every order received with a 3MF download for each.
   **✎ Modifier ce produit** reopens the same screen on a published
   product: rename it, switch its export mode, rename/retune/remove its
   zones, or click new faces to add more. Zones you keep are left exactly
   where they are (their stored face is reused untouched), the link and
   past orders are unaffected, and you can't save a product with no zones
   left. The 3D model itself is fixed once published — the zones are
   pinned to that mesh's faces — so changing model means a new product.
4. **Customer side** (`/o/<product_id>`, no login): upload an SVG, exclude
   shapes/mirror it if needed, drag/resize/fit it into the approved zone(s),
   hit **Envoyer ma commande** — they get a short order code back. Nothing
   else happens automatically yet (no payment, no email) — wire that code
   into whatever order form/checkout you already use.

## How the plain tool works

1. **Upload the 3D model.** It's parsed with `trimesh` and converted to glTF
   for the in-browser viewer (Three.js), face-for-face identical to the
   server-side mesh — the triangle index the browser reports on a click is
   the exact triangle index the backend uses.
2. **Upload the SVG logo.**
3. **Click a flat face.** The backend flood-fills outward from the clicked
   triangle, gathering every triangle that shares (within tolerance) its
   normal and its plane — i.e. the whole flat patch, not just one triangle —
   and reports its size so the logo can be auto-sized to fit.
4. **Adjust size / rotation / offset** with the sliders; a live (boolean-free)
   preview updates in the 3D view.
5. **Pick a mode and export:**
   - **Relief (emboss)** — the logo is extruded and placed as its own
     protruding object, sunk slightly into the model's surface so the two
     parts bond instead of merely touching. Works on any model.
   - **Gravé (deboss)** — the logo's footprint is *subtracted* from the
     model (a boolean cut via `manifold3d`) and a matching **fill piece** is
     produced to sit exactly in the resulting pocket — the classic two-color
     engraved-logo workflow. Requires the input model to be watertight.

Either way the export is a single `.3mf` containing two objects at their
final absolute positions — open it in your slicer and assign a different
filament/color to each.

## Configuration (`.env`)

| variable | default | description |
|---|---|---|
| `DASHBOARD_PASSWORD` | — | login password; leave empty to disable login |
| `SECRET_KEY` | — | session cookie signing key |
| `SESSION_TTL_HOURS` | `6` | how long an upload session (and its files) is kept |
| `MAX_UPLOAD_MB` | `200` | upload size cap |

## Notes

- Sessions (uploaded files + cache, for the plain tool **and** for a
  customer mid-order) live under the `./data` volume, one directory per
  session, cleaned up automatically after `SESSION_TTL_HOURS`. **Products
  and submitted orders are not sessions** — they're kept indefinitely
  (`./data/autologo.db`, `./data/products/`, `./data/orders/`) until you
  delete a product from its admin page.
- The live preview never runs a boolean operation (it just shows where the
  logo will sit) — only **Export** in *gravé* mode runs the actual cut, so
  slider dragging stays fast even on a large model.
- A **3MF** with real per-part color (`<basematerials>`/`<m:colorgroup>`
  display colors — set in your slicer/CAD tool) shows that color in every
  viewer and as the gallery card's swatch, instead of the flat default gray.
  Plain STL/OBJ imports, or a 3MF with no color info, keep the default.
- **Ajuster à la plaque / fit-to-plate** fits the logo against the flat
  region's *actual outline*, not its bounding box — a round or L-shaped
  spot is smaller than the rectangle around it — with a 1&nbsp;mm clearance
  on every side.
- **A logo SVG may use up to 3 colors.** Fills are read from `fill`
  attributes, inline `style="fill:…"`, **and `<style>` blocks with class /
  id / element selectors** (how Illustrator, Figma and most "optimized"
  SVG exports actually store color), following normal CSS precedence and
  group inheritance. Each element's resolved fill is read and
  every distinct color becomes its own object in the exported 3MF
  (`logo_1_ff0000`, `logo_2_0000ff`, …) so you can assign one filament per
  color in the slicer; all groups share one placement, so they stay in
  register. The shape picker and the 3D preview show the real colors. A
  4th+ color is merged into the nearest kept one rather than dropped, and
  `fill="none"` shapes (stroke-only guides) are ignored. An SVG with no
  fill info prints as a single default color, exactly as before.
- If a *gravé* export fails with a "not watertight" error, the source model
  has gaps/non-manifold geometry that the boolean engine can't cut through
  cleanly — repair it first (e.g. in Blender / PrusaSlicer's fix tool), or
  use *relief* mode instead, which has no such requirement.
