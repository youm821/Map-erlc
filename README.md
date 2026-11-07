# ERLC Navigator – deploy on Render

## Deploy
1. Put this folder in a GitHub repo (the `.gitignore` is already set).
2. On render.com: **New → Blueprint**, pick the repo (it reads `render.yaml`).
   Or **New → Web Service**: Runtime `Node`, Build `npm install`, Start `node server.js`.
3. Add environment variables:
   - `ERLC_SERVER_KEY` – your server key (ER:LC → Settings → API). Stays on the server.
   - `ADMIN_PASSWORD` – the password you'll type in the Admin panel to edit roads.
4. Deploy, then open your `onrender.com` URL.

## Using it
- **Live API:** open the "Live API" section, press **Auto**. Add your Roblox name to auto-set From.
- **Admin:** unlock with `ADMIN_PASSWORD`, edit roads/postals. Edits save for everyone.

## Saving edits (important)
Render's free plan has a temporary disk: edits are lost when the service restarts or redeploys.
Pick one:
- **Permanent, free:** in Admin press **Export**, copy the JSON into `defaults/map.json`, commit and push.
- **Permanent, paid:** add a Render Disk (mount `/var/data`) and set env var `DATA_DIR=/var/data`.

## Local test
`ADMIN_PASSWORD=test ERLC_SERVER_KEY=yourkey node server.js` → http://localhost:3000

## Files
`server.js` (site + API proxy + saving) · `public/index.html` · `public/map.jpg` · `defaults/map.json`
