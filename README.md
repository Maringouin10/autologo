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
4. **Identical faces.** A cube's four sides, a keychain's two faces… mark
   them as one **groupe de faces identiques** in the zone form (the
   *Faces identiques* picker: pick a face, choose the group, add it, then
   click the next face — the picker stays on the same group). The customer
   then gets a single control for the whole group with two buttons:
   **Le même partout** (one logo, placed once, applied to every face of the
   group) or **Un par face** (one dropzone and one placement per face).
   Ungrouped zones behave exactly as before.
5. **Customer side** (`/o/<product_id>`, no login): upload an SVG, exclude
   shapes/mirror it if needed, drag/resize/fit it into the approved zone(s),
   pick the filament colors, hit **Envoyer ma commande** — they get a short
   order code back. Nothing else happens automatically yet (no payment, no
   email) — wire that code into whatever order form/checkout you already use.

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

## Reading the SVG

A logo is read shape by shape (that is what makes the shape picker and the
per-color export possible), which means the reader has to reproduce what a
browser would draw — and that is where misplaced pieces came from:

- **Transforms are composed from the SVG root down.** Every real export
  (Illustrator artboards, Inkscape layers, Figma frames) nests shapes in
  transformed groups; a shape lifted out of its ancestors landed at the
  untransformed position. The matrices are also computed here rather than
  by trimesh, whose SVG reader mis-reads `rotate(a)` (it treats the angle
  as radians) and `translate(tx)` (it reuses tx for ty) — both of which
  silently move a piece somewhere else. `matrix`, `translate`, `scale`,
  `rotate` (with or without a centre), `skewX`/`skewY` and multi-function
  transform lists are supported.
- **Only what the file actually draws is imported.** `<defs>`, `<clipPath>`,
  `<mask>`, `<symbol>`, `<pattern>` and friends define content that is not
  rendered on its own — walking into them used to add phantom pieces, most
  visibly a `<defs>` background rect covering the whole canvas. Elements
  hidden with `display:none` / `visibility:hidden` are skipped too.
- **`<use>` is expanded**, with its own `x`/`y`/`transform` applied, so a
  logo built out of repeated symbols keeps all of its pieces (they used to
  vanish, or show up once at the original's position).
- `fill="none"` shapes (stroke-only guides) are still ignored, and colors
  still come from `fill` attributes, inline styles and `<style>` blocks.

`tests/test_svg_parsing.py` pins all of the above:

```bash
python -m unittest discover -s tests
```

## The logo edit step

- **Each thumbnail is drawn in the whole logo's frame**, with the rest of
  the logo ghosted behind it — so a card shows *where* its piece sits
  instead of a context-free silhouette scaled to its own bounding box.
- **The big preview is the editing surface**: click a piece to exclude it,
  click it again (it stays visible, ghosted) to put it back. Hovering a
  card outlines the matching piece, and vice versa.
- A piece that covers nearly the whole logo and is solid gets a **`fond ?`**
  badge — that is almost always a background plate to remove.
- **Tout inclure / Tout exclure** plus a `n/m formes incluses` counter.
- Excluding every piece no longer fires a request the server can only
  refuse: the step says what is wrong and holds the export/order button.
- Both the vendor tool and the customer page share one implementation
  (`app/static/js/logo-editor.js`); on the customer page the thumbnails are
  drawn in the **chosen filament colors**, not the artwork's own.

## Couleurs d'impression

The customer picks a filament for **the object itself** and one for **each
color their logo uses**, from a palette of what you stock — a color counter
keeps the whole order within `MAX_PRINT_COLORS` (4 by default: one AMS/MMU's
worth), and an order that exceeds it can't be submitted.

- The palette lives in `app/config.py` (`DEFAULT_PALETTE`) and can be replaced
  per-deployment with the **`FILAMENT_COLORS`** env var — JSON, e.g.
  `[{"name":"Noir","hex":"#1c1c1e"},{"name":"PETG rouge","hex":"#d92b2b"}]`.
  An unparseable value falls back to the built-in list rather than leaving a
  customer with no colors to pick.
- Picks are applied everywhere at once: the 3D view repaints the object and
  the logo, the shape thumbnails show the chosen filaments, and the exported
  3MF carries them as real per-object display colors — trimesh's own 3MF
  writer drops color entirely, so the app injects the `<basematerials>`
  resource itself (`meshwork._inject_3mf_colors`). How far a given slicer
  honors that varies, so **the admin also lists each order's colors** as
  swatches (hover for the filament name) next to its download button.
- Two source colors mapped to the same filament merge into one object in the
  export — one filament, one object.
- The colors are chosen per order, not per product: `/tool` (the plain
  single-model tool) still exports in the model's own colors.

## L'interface

Toutes les pages partagent un même thème (`app/static/css/style.css` — tous
les tokens de couleur/rayon/ombre sont dans son bloc `:root`) et un gabarit
Jinja commun (`app/templates/base.html`).

- **Utilisable au téléphone** : sous 860 px, l'écran de placement s'empile —
  l'objet 3D en haut, les réglages dans une feuille défilante en dessous —
  au lieu d'une barre latérale fixe de 320 px illisible sur mobile. La
  galerie et l'admin passent en colonne unique.
- **Parcours guidé** : chaque étape porte un numéro qui passe au vert une
  fois franchie, et les étapes suivantes restent grisées tant qu'elles ne
  sont pas accessibles.
- **Les erreurs ne passent plus inaperçues** : elles s'affichent en toast
  (coin de l'écran) au lieu d'une ligne rouge en bas d'un panneau défilant,
  et les opérations longues (import, découpe booléenne, envoi de commande)
  couvrent la vue 3D d'un voile avec un libellé disant ce qui se passe.
- **Vue 3D** : fond dégradé, bouton *recentrer* (⟳) pour retrouver un modèle
  qu'on a perdu en orbitant, et bouton plein écran (⛶).
- **Admin** : les produits sont des cartes (couleur du modèle, nombre de
  zones, pastille « à traiter » s'il y a des commandes en attente) et les
  dates sont relatives (« il y a 2 h »), l'horodatage exact restant en
  infobulle. Chaque commande affiche les filaments choisis en pastilles.

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
