# Uri Eugenio webshop — site generator

Builds the complete static site from `D:\Webshop\content\sources` into `D:\Webshop\build\dist`.
The generator only **reads** the sources folder; it refuses to write anything inside it.

## 0. Project layout

```
D:\Webshop\
├── code\      ← this folder: the git repository (github.com/urieugenio/webshop)
│   ├── build.mjs, config.json, package.json, run.bat
│   ├── backoffice.mjs, backoffice.bat, backoffice\   the collection editor (see 4a)
│   ├── lib\       generator modules
│   ├── site\      front-end css + js (copied into the build with a hash in the name)
│   ├── assets\    fonts
│   ├── samples\   example markdown
│   ├── tools\     pre-commit check against secret keys (see "Git" below)
│   └── node_modules\   (not in git; recreated by "npm install")
├── content\
│   ├── sources\   everything the build reads: logo, splash, collection, gallery, content pages, attributes.txt, collection.json
│   │              ← its own git repository (github.com/urieugenio/webshop-content): the texts and data, not the pictures
│   ├── design\    poster, layout samples, logo artwork, mockups
│   └── prompts\   working notes / prompts
└── build\     ← generated, never in git, safe to delete (a rebuild recreates it)
    ├── dist\      the website exactly as it is published
    └── cache\     build cache: sizes, colours, thumbnail slots, publish manifest
```

The three folders are siblings, so the code repository can only ever see `code`. Paths to the other two are set in
`config.json` (`sourcesDir`, `outDir`, `cacheDir`) and can be overridden per run with `--sources=` / `--out=`.

## 1. One-time setup

1. Install **Node.js LTS** (version 22 or newer) from https://nodejs.org. Use the default options.
2. That's it. The first time you run `run.bat` it runs `npm install`, which fetches `sharp` (image processing), `marked` (markdown) and `sortablejs` (drag and drop in the backoffice).

### Git (code only)

Install **Git for Windows** from https://git-scm.com (default options; it includes Git Credential Manager,
which signs you in to GitHub through the browser the first time you push). Then, once, in `D:\Webshop\code`:

```
git config --global user.name  "Uri Eugenio"
git config --global user.email "<the email address of your GitHub account>"
git init -b main
git add .
git commit -m "Initial commit: site generator"
git remote add origin https://github.com/urieugenio/webshop.git
git push -u origin main
```

If the GitHub repository was created with a README or licence, run `git pull --rebase origin main` before the push.
`git status` should never list photos, `dist` or `node_modules`; if it does, something ended up inside `code` by mistake.

### Git (content)

`content\sources` is a second repository with the texts and product data: `content\*.md`, `collection.json`
(written by the backoffice), `attributes.txt` and `logo.svg`. Its `.gitignore` leaves out the picture folders
(`splash`, `gallery`, `collection`) and every jpg/png/psd, so only text is versioned; the pictures are backed up
separately (the raw files in Lightroom are the master). After editing texts or a session in the backoffice:

```
cd D:\Webshop\content\sources
git add -A
git commit -m "what changed"
git push
```

`git log -p collection.json` shows every change to the product data.

### No secrets in git

Both repositories are **public**. Stripe and Cloudflare keys belong in `code\.env` (ignored by git) or in the
Stripe/Cloudflare dashboards, never in a committed file. A check in both repositories refuses any commit that adds
a `.env`/key file or something that looks like a Stripe secret key (`sk_…`, `rk_…`, `whsec_…`), a Cloudflare token
or a private key. Git does not copy such checks along with a repository, so after cloning either repository run once:

```
node tools\install-hooks.mjs
```

## 2. Building

Double-click **`run.bat`**, or from a terminal in `D:\Webshop\code`:

```
node build.mjs            build / update dist (only changed objects are regenerated)
node build.mjs --serve    build, then serve the site on http://localhost:8080
node build.mjs --clean    throw away dist and the cache, rebuild everything
node build.mjs --serve --lan   the same as --serve, and also reachable from a phone on the same network
```

**On your phone:** double-click **`serve-lan.bat`**. It builds the site and prints an address such as
`http://192.168.2.12:8080/`; open that on a phone or tablet on the same wifi. The address comes from the router
(DHCP), so it can change from day to day: always use the one printed. The first time, Windows may ask whether Node.js
may communicate on networks: allow it for **private** networks. Without `--lan` the site is only reachable from this computer.

The first build takes about two minutes (the large splash masters are the slow part). After that a run with
no changes takes under a second. The end of each run prints how many objects were new, changed or deleted.

How "only what changed" works:

- every generated image has a fingerprint of its source (size + modified time) in its file name, so an existing file is never regenerated;
- every photo keeps a fixed **slot** on the thumbnail sheets (`build\cache\slots-*.json`). Adding or removing a photo only rebuilds the sheet that holds that slot; all other sheets stay byte-identical;
- text files (`index.html`, css, js, data) are only rewritten when their content changes;
- files that no longer belong to the site are removed from `dist`;
- `build\cache\dist-manifest.json` keeps a hash of every published object. Phase 2 uses it to upload only the difference to Cloudflare.

## 3. Viewing the site from disk (Chrome)

Open `D:\Webshop\build\dist\index.html` by double-clicking it or dragging it into Chrome.

**You don't need to change any Chrome settings.** I built the site so it never uses `fetch()` for its own data:
the catalog is loaded as a normal `<script>`, and thumbnails are CSS backgrounds rather than canvas pixels. Chrome
only blocks those two things on `file://` pages.

Two notes:

- the cart is stored in `localStorage`. On `file://` Chrome shares that storage between all local files. Harmless, but don't be surprised;
- if you ever want the site to behave exactly as it will online, run `run.bat --serve` and open http://localhost:8080.
  (Only if you insist on extra file permissions: start Chrome with `chrome.exe --allow-file-access-from-files`
  while all Chrome windows are closed. It is not needed for this site.)

## 4. What goes where (`content\sources`)

| source | used for |
|---|---|
| `logo.svg` | the centred logo on the splash page |
| `splash/*.jpg` | splash background. `splash-master.jpg` plus its wider versions `splash-master-wide.jpg` (16:9) and `splash-master-superwide.jpg` (32:9), all the same height with the figure centred. From these the build renders every aspect in `splash.aspects`, each cut from the narrowest master that is wide enough, so only the sides are ever cropped. Any other picture (with its own optional `-wide` / `-superwide` versions) becomes an extra cross-fading slide. `.psd` files are ignored |
| `collection/*.jpg` | collection products (square) |
| `attributes.txt` | the choices for price, size, … (see **4a**) |
| `collection.json` | order, name, price, size of every product. Written by the backoffice (see **4a**) |
| `gallery/*.jpg` | gallery pictures, any aspect ratio. **Create this folder** — while it is missing, the gallery says "new pictures coming soon" |
| `content/site.md` | the whole page below the splash: all sections, see **The page: site.md** below |
| `content/images/` | the pictures used in `site.md` |
| `content/booklet.md` | the 8-page booklet in the box (see **4c**) |

**Colour profile of the photos.** Export from Lightroom in **Display P3** (Export → File Settings → Color Space) for
the most faithful colours on iPhones, iPads, Macs and recent Android phones. sRGB cannot show saturated turquoise and
cyan: an sRGB export turns those into a bright blue (on Nancy, 63 % of the pixels were clipped). The build keeps a
Display P3 photo in P3 (detail images, and the thumbnail sheet it is on); browsers convert it for sRGB screens.
sRGB photos keep working as before; AdobeRGB photos are converted to P3 (phones cannot show more than P3).
A re-exported photo is regenerated by the next build automatically.

### The page: site.md (`content\sources\content`)

The whole page below the splash is one markdown file, `site.md`. To reorder, add or remove a section, move, add or
delete its text; rebuild to see it.

```markdown
## Handmade crochet. Wearable art.
Every piece made by hand, one of a kind.

# Beanies
Use the filters to find the piece that suits you.

{{beanies}}

Can't find what you're looking for? …

# My story
I was born on the island of St. Maarten …

![Uri Eugenio wearing an orange-to-lime crochet beanie](0E2A5686-my_story.jpg)
```

- **sections**: every line starting with `# ` starts a section. Its title is shown in yellow (first letter always
  uppercase), it is an entry in the menu, and it gets a link made from the title: `# My story` is `#my-story`.
  Use `## ` for subheadings inside a section.
- **intro banner**: the text before the first `# ` line is the banner at the top, without title or menu entry.
- **pictures**: `![description](file.jpg)` puts a picture from `content\images` exactly there, at the full column
  width. The description is read by screen readers and search engines; write what the picture shows. File names
  without spaces (Markdown does not allow them). Converted to webp in widths 480/820/1240/1640 (`content.imageWidths`)
  and lazy loaded. Pictures are always shown landscape: a portrait or square picture (narrower than
  `content.landscapeMinAspect`, 1.1) is cropped to `content.cropAspect` (1.5 = 3:2), keeping the top of the photo
  (`content.cropPosition`: "north"; other options "centre", "south", "attention" = most detailed part).
  A picture that is missing, or a picture in `images` that `site.md` does not use, is reported by the build.
- **grids**: a line with only `{{beanies}}`, `{{scarves}}` or `{{gallery}}` places that grid there, full width.
  The beanies grid comes with its filter bar. A grid without pieces or pictures shows "coming soon".

## 4a. Backoffice (`backoffice.bat`)

Double-click **`backoffice.bat`** (or `npm run backoffice`). It opens http://localhost:8081 in the browser; close the
black window to stop it.

- the grid shows every photo in `collection\` with its name, price and size, in the order of the site;
- **drag** a piece to change the order;
- **click** a piece to edit it. Closing the editor (Close, Esc, or clicking next to it) saves. ‹ › or the arrow keys go to the previous/next piece;
- **Build site** runs the generator and shows its output; **View site** opens the result.

Every change is saved straight away to `sources\collection.json`, the only file the backoffice writes in `sources`.
The previous version is kept in `build\cache\backoffice\collection.previous.json`.

**Names.** The name is shown in the detail pane and is the link to the piece: "Cape Town" → `#cape-town`.
A new photo gets a free city name from `backoffice\cities.txt`; ↻ in the editor suggests another one.
`cities.txt` holds the 10,000 largest cities of countries that use the Latin alphabet, one-word names only. It is made from the GeoNames list
(`content\sources\cities15000.txt`, geonames.org, CC BY 4.0) with `node backoffice\make-cities.mjs`; run that again to remake it
(an optional second argument sets the number of names).
Names must be unique and cannot be the name of a section (`collection`, `contact`, …).
Renaming a piece changes its link. The file name (`DSC01606`) is still used for the images and the cart.

**New and removed photos.** A photo you add to `collection\` appears at the end of the grid with the default attributes
the next time the backoffice (re)loads. If you remove a photo, its entry stays in `collection.json` but is not shown, so it keeps its name
if the photo comes back.

**Colours.** The backoffice measures the colour of every new photo when it starts (the first time this takes
about half a minute for 145 photos). It stores the nearest palette colour, whether the piece is multicoloured, and
the measured colour itself. The dot on each tile shows the result; a half-rainbow dot means multicolour.
Click a colour above the grid to see only those pieces, which is a quick way to check the detection.
To correct a piece, change *colour* or *multicolour* in its editor: it is then marked "set by hand" and never changed
by a new measurement. **measure** in the editor measures that photo again; **Measure colours** in the top bar measures
every photo again except the ones set by hand (use it after changing the palette or the thresholds).

How it measures (`lib/colors.mjs`): the dominant colour comes from the front of the crown, above the label.
For *multicolour* the crown plus the side right of the label is split into two colour groups: a plain piece splits into
lit and shaded yarn of one colour, a multicoloured piece into two clearly different colours. On the first 145 photos
the dominant colour was almost always right and *multicolour* matched a human eye for about 9 out of 10 pieces;
fine pastel speckles and gradients that only change near the brim are the usual misses.

On the site the collection has a filter bar: colour dots, multicolour, and a chip per price and per size (and per value of
any attribute you add). Within a row any choice matches, between rows all must match: *blue + multicolour + € 180*
shows the multicoloured pieces that are mostly blue and cost € 180. The ‹ › arrows in the detail pane skip the pieces
the filter hides.

### attributes.txt

```
[price]
150
*180
220

[size]
*54-56 cm
56-58 cm
```

- every `[section]` is one attribute: a dropdown in the backoffice and a line under the price on the site;
- one value per line; `*` marks the default for new photos (without a `*` new photos get no value);
- `price` is a number in euros; all other values are shown exactly as written;
- add a section (e.g. `[colour]`) to add an attribute; removing a value from the list does not change pieces that already have it
  (the backoffice shows it as "not in attributes.txt").

## 4b. Printed card for the box (`booklet.mjs`)

One 140 × 200 mm card per product for the back of the box (the front carries the splash picture with the logo):
the photo full-bleed at the top, then name, model, material, thickness, size, care, how to wear, "stay in touch"
(website, email, Instagram), a thank you with "Handmade in Amsterdam", and a line for Uri's signature.

```
node booklet.mjs                       every product, in the order of the site
node booklet.mjs --only=Nancy,Pavia    just these products
```

It writes to `D:\Webshop\build\print`:

- `booklet-A4-proof.pdf`: one card (with its 5 mm bleed) per A4 sheet, with crop marks, for proof prints at home;
- `booklet-SRA3-4up.pdf`: four cards per SRA3 sheet (320 × 450 mm) with crop marks, for the print shop.

The photos come from `collection-print` (Lightroom export in **Adobe RGB**, same file names as `collection`). They
are embedded unconverted with their Adobe RGB profile, at 300 dpi; the dark background is widened a little so the
trim never cuts into a beanie. Fonts: Lato (as on the site; the website
address is Lato Regular with a thin outline, as there is no Lato Bold) and Great Vibes (`assets\fonts`, OFL licence).

## 4c. Booklet in the box (`story-booklet.mjs`)

An 8-page A6 booklet (105 × 148.5 mm) from **one A4 sheet**, printed double-sided in black only on a monochrome
laser printer: congratulations, my story, care, contact. The text is `content\sources\content\booklet.md` (next to
`site.md`); the comment at its top explains the format (`---` starts a page, `{{logo}}`, `{{photo …}}`, …).
The logo is "Uri Eugenio" in Great Vibes, drawn as outlines; no image files.

```
node story-booklet.mjs                 printer set to flip on the long edge (the usual duplex setting)
node story-booklet.mjs --flip=short    printer set to flip on the short edge
```

It writes to `D:\Webshop\build\print`:

- `story-booklet-A4-duplex.pdf`: the two sides of the sheet. Print double-sided at **actual size** (100 %, not "fit to page");
- `story-booklet-pages.pdf`: the 8 pages in reading order, to read on screen.

Folding: hold the sheet with the cover (Uri Eugenio) bottom right, facing you. Fold the top half **backwards** onto
the bottom half (the fold parallel to the short edge), then fold the left half **backwards** onto the right half: the
cover is on the front, the second fold is the spine. Cut open the first fold (the top edge of the booklet), and
staple twice through the spine. The script reports a page with too much text, and pages with a lot of room left.

The picture (`{{photo 0E2A5319.jpg}}`, from `gallery` or `content\images`) is converted for the laser printer: a grey
mix that is mostly the blue channel (so the purple backdrop turns light and the green outfit dark), the background
pushed to paper white, the deepest shadows lifted a little (a laser printer fills them in), 300 dpi.
Tune with `PHOTO_MIX`, `PHOTO_WHITE` and `PHOTO_BLACK` at the top of the script. Without `{{photo …}}` no image is used.

## 5. Tuning (`config.json`)

All tunables are in `config.json`, and the front-end reads them from the generated data file. A tuning panel can drive the same values later.

| setting | meaning |
|---|---|
| `layout.contentWidth` | width (px) of the page column: text, section pictures and thumbnail grids share it |
| `layout.gap` / `layout.border` | space between thumbnails and the width (px) of the border around each thumbnail; its colour is `theme.thumbBorder` |
| `theme.imageShadow` | drop shadow under thumbnails and pictures (`none` = off) |
| `layout.minThumbWidth` | desktop: columns = as many as fit at this minimum width |
| `layout.phoneColumns`, `layout.phoneBreakpoint`, `layout.sideMarginPhone` | 3 columns below 600 px, 4 px side margin |
| `layout.galleryRowScale` | gallery row height relative to the collection thumb size |
| `theme.*` | colours (VS Code dark), emboss light/dark edge colours, accent yellow |
| `thumbs.collection.tileSizes` | resolutions per thumbnail on the sheets. The browser picks the smallest one that is sharp at its pixel density |
| `thumbs.*.tilesPerRow` | 4 → 4×4 = 16 thumbs per sheet (2048×2048 px at 512) |
| `thumbs.lazyMargin` | how far (px) ahead of the viewport sheets start loading |
| `splash.aspects` / `frame` / `frameScales` | splash backgrounds in 32:9, 24:9, 16:9, 4:3, 3:4 and 9:16, each fitted inside 7680x2160, half and a quarter of that. The browser takes the narrowest aspect that is at least as wide as the window (image fills the full height, sides cropped) and the smallest size that covers the window at its pixel density |
| `logo.landscapeWidthAt16x9` / `portraitWidthAt9x16` | 0.62 / 0.85, as specified |
| `logo.taglineTop` / `taglineWidthOfLogo` | tagline at 10 % from the top; tagline width as a fraction of the logo width (taken from layout-portrait.png) |
| `animation.paneSeconds` / `ease` | 1 s, `power2.out` (cubic-bezier 0.215, 0.61, 0.355, 1) |
| `colors.palette` | the filter colours: `name`, the `hex` shown on the site, and optional `refs`: example colours that count as this colour (a measured colour gets the name of the nearest example). Add a reference colour when a kind of beanie lands in the wrong colour |
| `colors.multiLabel` | the word for multicoloured pieces ("multicolour") |
| `colors.analysis` | where the colour is measured (fractions of the photo: left, top, right, bottom) and `multiDelta`: how different the two colours must be for "multicolour". Lower = more pieces count as multicolour (18.3 was calibrated on the first photos) |
| `shop.previewSoldIds` | **phase 1 only**: these items are shown as sold so you can judge the "sold" band. Empty the list when going live |
| `shop.liveInventory` | phase 2: switch on to read the inventory from Cloudflare D1 every `pollSeconds` |

Changing tile sizes or quality simply generates new files on the next run; the old ones are cleaned up.

---

## 6. Phase 2 — what I need from Cloudflare

**An API token (custom token) plus your Account ID.**

1. Log in at https://dash.cloudflare.com.
2. Copy your **Account ID**: Workers & Pages → Overview, right-hand column (or the URL: `dash.cloudflare.com/<account-id>/…`).
3. Click your profile icon (top right) → **My Profile** → **API Tokens** → **Create Token**.
4. Scroll to **Custom token** → **Get started**.
5. Token name: `urieugenio-webshop-deploy`.
6. Permissions (each one is a row: *Account* · *permission* · *Edit/Read*):
   - **Account · Cloudflare Pages · Edit**: create the project and upload the site
   - **Account · D1 · Edit**: create the product/order database and run its migrations
   - **Account · Account Settings · Read**: lets the deploy tool look up the account
   - only if you want to attach your own domain (e.g. shop.uri.eu) from the script: **Zone · DNS · Edit**, with the zone restricted to that domain under *Zone Resources*. Otherwise leave this out; you can attach a domain by hand in the dashboard.
7. Account Resources: **Include · your account** (not "All accounts").
8. Client IP filtering and TTL: leave empty, or set an end date if you prefer.
9. **Continue to summary** → **Create Token** → copy the token. It is shown only once.

Don't paste the token into a file in `sources` or into `config.json`. In phase 2 the script reads it from a local
file `code\.env` (listed in `.gitignore`, so it never reaches GitHub) or from the environment variable `CLOUDFLARE_API_TOKEN`.

The Pages Functions run inside the Pages project, so you don't need a separate Workers permission. The database binding
and the Stripe secrets are set on the Pages project by the script.

Also tell me the project name you want (it becomes `<name>.pages.dev`, e.g. `urieugenio`) and whether a custom domain is coming.

## 7. Phase 3 — what I need from Stripe (sandbox)

In the Stripe dashboard, with the **sandbox / test mode** switch on:

1. **Developers → API keys**:
   - the **Publishable key** (`pk_test_…`)
   - the **Secret key** (`sk_test_…`). For live mode later we'll create a **restricted key** with only *Checkout Sessions: Write* and *Events: Read*.
2. The **webhook signing secret** (`whsec_…`) comes later: once the site is on Cloudflare, we add an endpoint
   (Developers → Webhooks → Add endpoint) at `https://<your-site>/api/stripe-webhook` with the events
   `checkout.session.completed`, `checkout.session.expired` and `checkout.session.async_payment_failed`.
3. Business decisions I need from you:
   - shipping: which countries, and the shipping cost (flat rate, free above an amount, per country?)
   - payment methods: cards, iDEAL, Bancontact, PayPal, … (Settings → Payment methods)
   - is VAT included in the prices (€ 180 incl. VAT?), and should Stripe Tax be used?
   - the business name and statement descriptor customers see on their bank statement
   - links to your terms / privacy / return policy pages (I can make simple pages for these)

How "first come, first served" will work: everyone can put the same piece in their cart. When someone presses
*checkout*, the Pages Function checks D1, reserves the piece for 30 minutes and creates the Stripe Checkout Session
(which expires at the same moment). Anyone else trying to check out the same piece in that window is told it is
being bought. The webhook marks it **sold** when payment completes, or releases it when the session expires.
All open pages pick up the change within a minute through the inventory poll.
