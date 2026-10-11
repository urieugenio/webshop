# Uri Eugenio webshop — site generator

Builds the complete static site from `D:\Webshop\content\sources` into `D:\Webshop\build\dist`.
The generator only **reads** the sources folder; it refuses to write anything inside it.

## 0. Project layout

```
D:\Webshop\
├── code\      ← this folder: the git repository (github.com/urieugenio/webshop)
│   ├── build.mjs, config.json, package.json, run.bat
│   ├── lib\       generator modules
│   ├── site\      front-end css + js (copied into the build with a hash in the name)
│   ├── assets\    fonts
│   ├── samples\   example markdown
│   └── node_modules\   (not in git; recreated by "npm install")
├── content\   ← local only, never in git
│   ├── sources\   everything the build reads: logo, splash, collection, gallery, content pages, collection.txt
│   ├── design\    poster, layout samples, logo artwork, mockups
│   └── prompts\   working notes / prompts
└── build\     ← generated, never in git, safe to delete (a rebuild recreates it)
    ├── dist\      the website exactly as it is published
    └── cache\     build cache: sizes, colours, thumbnail slots, publish manifest
```

The three folders are siblings, so git can only ever see `code`. Paths to the other two are set in
`config.json` (`sourcesDir`, `outDir`, `cacheDir`) and can be overridden per run with `--sources=` / `--out=`.

## 1. One-time setup

1. Install **Node.js LTS** (version 22 or newer) from https://nodejs.org. Use the default options.
2. That's it. The first time you run `run.bat` it runs `npm install`, which fetches `sharp` (image processing) and `marked` (markdown).

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

## 2. Building

Double-click **`run.bat`**, or from a terminal in `D:\Webshop\code`:

```
node build.mjs            build / update dist (only changed objects are regenerated)
node build.mjs --serve    build, then serve the site on http://localhost:8080
node build.mjs --clean    throw away dist and the cache, rebuild everything
```

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
| `collection.txt` | price, material, description per product (see below) |
| `gallery/*.jpg` | gallery pictures, any aspect ratio. **Create this folder** — while it is missing, the gallery says "new pictures coming soon" |
| `content/*.md` | the page sections, see **Content sections** below |
| `content/*-<section>.jpg` | one optional picture per section |

### Content sections (`content\sources\content`)

Every section of the page below the splash is a markdown file named `<number>_<name>.md`:

```
1_intro.md  2_collection.md  3_my_story.md  4_gallery.md  5_market.md  6_contact.md
```

- **order**: the number decides the order on the page and is never shown. Renumber the files to reorder; rebuild to see it.
- **new section**: just add a file, e.g. `7_press.md`. Its id (for links like `#press`) is the name part.
- **title**: the first line starting with `# ` is the section title (yellow, first letter always uppercase) and its menu entry.
  A file without a `# ` line gets no title and no menu entry: that is how the intro banner works.
  Use `## ` for subheadings inside a section.
- **thumbnail grids**: the sections named `collection` and `gallery` are followed by their thumbnail grid.
- **picture**: one per section, named after the section with anything in front of it, e.g. `0E2A5427-collection.jpg`
  or `Uri Eugenio_contact.png` (`-`, `_` and spaces are interchangeable; .jpg/.jpeg/.png in any case).
  It is shown at the full column width, right after the first paragraph of the section
  (title, paragraph, picture, then the rest). Converted to webp in widths 480/820/1240/1640 (`content.imageWidths`) and lazy loaded.
  Pictures are always shown landscape: a portrait or square picture (narrower than `content.landscapeMinAspect`, 1.1)
  is cropped to `content.cropAspect` (1.5 = 3:2), keeping the top of the photo (`content.cropPosition`: "north";
  other options "centre", "south", "attention" = most detailed part).
  If there are two pictures for one section the build warns and uses the last one; a picture that matches no section is reported.

### collection.txt

```
#file::price::material::description
*::180::merino::single strand beanie made with fine hand-dyed merino wool.
1606-1616::180::merino::foldable double strand beanie made with hand-dyed merino wool.
1620,1625,1630-1633::150::alpaca::...
```

- the identifier matches the **end** of the file name: `1606` matches `DSC01606.jpg`;
- `1606-1616` matches every file whose trailing number is in that range;
- several identifiers can be separated by commas;
- `*` matches every file, which makes it a good place for defaults;
- more specific beats less specific (exact > range > `*`); between rules of the same kind, the later line wins;
- the header line decides the column order. You can add columns, e.g. `#file::title::price::material::description`; a `title` column is shown above the price.

Your current lines have three fields while the header has four. The generator reads them as identifier · price · description,
so material stays empty. Add the material as the third field when you want it shown.

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
