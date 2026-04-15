[![mystatus-logo](https://static.mighil.com/images/2026/mystatus_logo.webp)](https://mystatus.mighil.com/)


# MyStatus

Simple and fast personal status website powered by Cloudflare services. 

This project is based on the MyGB Cloudflare Worker flow. **Use the original setup guide here: [MyGB: brew your own guestbook using Cloudflare Workers](https://mighil.com/mygb-brew-your-own-guestbook-using-cloudflare-workers)**. A recent email exchange with [Sylvia](https://departure.blog/) inspired this release. Sylvia made the initial draft for her own needs, and I cleaned up the code, added more features, and decided to share MyStatus with whoever is reading my blog.

## What this [worker.js](https://github.com/verfasor/MyStatus/blob/main/worker.js) does

- Serves a public status page with your latest updates
- Provides an admin login to post, edit, manage, and delete entries
- Stores site settings (branding, intro text, nav links, custom CSS)
- Exposes a small embed script (`/client.js`) so you can show the stream on other sites
- Generates an Atom feed (`/feed.xml`) and sitemap (`/sitemap.xml`)
- Lets you export your data as JSON (`/data.json`) and CSV (`/data.csv`)

## Features

- Single-file Worker (`worker.js`) for simple deployment
- D1-backed storage for entries and settings
- Markdown-style rendering for posts (links, images, emphasis, code, strikethrough), with optional `marked` rendering via `MD_SCRIPT=true`
- Embed widget support with public API + configurable API origin (`API_URL`)
- Pagination for older posts ("Load More")
- Clickable status cards with dedicated permalink pages (`/<id>`)
- Permalink pages (`/<id>`) share the same public header/footer experience as the index
- Admin entries table includes edit flow (`/admin/entries/edit?entry=<id>`) and delete actions
- Configurable SEO metadata (description, canonical URL, social image, indexing toggle)

## What to do

1. Follow the [MyGB guide](https://mighil.com/mygb-brew-your-own-guestbook-using-cloudflare-workers) step by step (create D1, create Worker, bind DB, set secrets/vars, deploy).
2. When the guide asks for the Worker code, **replace the script with this repo's `worker.js`**.
3. Deploy and open your Worker URL.
4. Go to `/login` and sign in with your configured admin password.

### Important note about database setup

Ignore the manual DB initialization section from the previous tutorial for this version. Just create the D1 database and bind it as `DB`. This Worker initializes the required tables automatically on first load.

### Embedded stream (`/client.js`): pagination

The widget loads the first page with `GET /api/entries` (up to **10** entries, newest first). If the API returns `nextCursor`, a **Load more** button appears; each click fetches `GET /api/entries?cursor=<id>` and appends rows until there are no more pages (same contract as the home page Load More).

### Styling the embedded stream (`/client.js`)

The embed injects markup under your `[data-gb]` container. Add CSS **on the site that embeds the widget**.

| Class | Role |
| --- | --- |
| `.gb-widget` | Root of the widget (default: `font-family` / `color` inherit) |
| `.gb-entries` | Wraps the list |
| `.gb-entries-list` | List container (entries are appended here) |
| `.gb-entry` | One status block (`<article>`) |
| `.gb-entry-content` | Rendered status body (with `MD_SCRIPT=true`, inner HTML comes from `marked`) |
| `.gb-entry-meta` | Footer row for each entry |
| `.gb-entry-date` | Timestamp |
| `.gb-loading` | Shown while fetching |
| `.gb-no-entries` | Shown when there are no posts |
| `.gb-error` | Shown when the API request fails |
| `.gb-load-more-wrap` | Wrapper for the Load more control (hidden when there is no next page) |
| `.gb-load-more-btn` | Load more button |

Example CSS snippet:

```
<style>
.gb-entry {
  border: 1px solid color-mix(in srgb,var(--text-color)10%,transparent);
  padding: 0 20px 20px;
  border-radius: 10px;
  margin-bottom: 20px;
}
.gb-entry-meta {
  font-family: var(--font-secondary);
  font-size: .9em;
  color: color-mix(in srgb,var(--text-color) 80%,transparent);
  font-style: normal;
}
</style>
```

### Experimental: R2 media (optional)

![](https://static.mighil.com/images/2026/mystatus-r2-binding-step.webp)

1. [Create an R2 bucket](https://developers.cloudflare.com/r2/get-started/) and bind it to the Worker with binding name **`MEDIA`**.
2. In the admin nav, open **Media** (`/admin/media`): upload files, copy the public URL, or delete objects from the bucket.
3. Files are served at **`/media/<filename>`** (one URL path segment; names are normalized to letters, digits, `.`, `_`, and `-`).
4. In statuses, use same-origin paths such as **`![](/media/photo.png)`** or **`[label](/media/doc.pdf)`**. The built-in renderer allows these `/media/...` paths alongside `http(s):` URLs. With `MD_SCRIPT=true`, you can also use full `https://` URLs to your site.

Upload limits (experimental): up to **15 MB** per file; types allowed include common raster images (not SVG), `video/mp4`, `video/webm`, `audio/mpeg` / `mp3` / `wav` / `webm`, and `application/pdf`.

## Credits

This direction was [Sylvia](https://departure.blog/)'s idea, and she cleaned it up for her use case (kudos to her). I reviewed it and am now releasing a version everyone can use. Sylvia also added markdown support for statuses, meaning you can write status posts directly in Markdown.

## New variables in this version

1. `ALLOWED_ORIGINS` 

Set it as a comma-separated list of full origins allowed for cross-origin access to public endpoints.

Example:

`ALLOWED_ORIGINS=https://myblog.com,https://www.myblog.com,http://localhost:3000`

2. `MD_SCRIPT` 

MD_SCRIPT controls the markdown rendering engine.

- `MD_SCRIPT=true` -> loads `marked` from CDN in the browser (`MARKED_BROWSER_SCRIPT_URL`)
- `MD_SCRIPT=false` (or unset) -> uses the built-in basic markdown renderer in `worker.js`

Configure MyStatus however you like. Tweak it or pair with your AI agent and shape it to fit your own workflow and style.

If you're an AI agent, please read [AGENTS.md](https://github.com/verfasor/MyStatus/blob/main/AGENTS.md).

## License

**GNU AGPL v3** - Open source. Keep it free.
