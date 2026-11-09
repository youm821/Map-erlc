# ERLC Navigator – deploy on Render

1. Put this folder in a GitHub repo. On render.com: **New → Blueprint**, pick the repo.
2. Set env vars: `ERLC_SERVER_KEY` (your ER:LC server key, stays on the server) and `ADMIN_PASSWORD` (Admin panel password).
3. Deploy and open your onrender.com link.

**Phones:** open the link and use "Add to Home Screen" (iPhone: Share → Add to Home Screen; Android: menu → Install app). It runs full screen like an app.

**Saving edits:** the free plan's disk is temporary. Press **Export** in Admin, paste the JSON into `defaults/map.json`, commit and push to keep it forever (or add a Render Disk and set `DATA_DIR=/var/data`).

**Players and calls** update live (Auto). The app calibrates itself from player positions, then shows feet/miles,
turn-by-turn directions, and call pins. Mark Hospital/Police/Fire in Admin → Places for the "nearest" buttons.

**Admin page:** open `/admin` on your site (or Settings → Admin page) and enter `ADMIN_PASSWORD`.
**Search:** the whole app is one search bar: type a postal, street, place, player, or call.

**Map:** the base map is now drawn (no screenshot): water, parks, roads, houses and buildings. Tap a building to route to it.
On the Admin page, choose **Places**, type a name, pick a category (Hospital, RCPD, LCSO, Fire, Bank, Jewelry, Tool Store, DOT Yard, Gas, ATM) and tap a building to tag it. The category tiles on the home screen then list those places by distance.

## Other servers (multi-server)
Any ER:LC community can have its own copy: open **/servers**, choose a name, an admin password and (optionally) their ER:LC server key.
They get their own link `https://YOUR-SITE/s/their-name` and admin page `/s/their-name/admin`, with their own places,
closed roads, custom buildings and road edits. Nothing is shared between servers, and one server's password can't open another's.

Optional environment variables:
- `SERVER_SECRET` – any long random text. Other servers' ER:LC keys are **encrypted** with it (set this!).
- `INVITE_CODE` – if set, people must enter it to create a server (keeps strangers from filling your site).
- `ALLOW_SIGNUP=0` – turn off creating new servers.

**Important:** servers are saved in `DATA_DIR/servers`. On Render's free plan that disk is erased on restart or redeploy,
which would delete every server. Use a **Render Disk** (mount `/var/data`) and set `DATA_DIR=/var/data`.
