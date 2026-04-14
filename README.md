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
