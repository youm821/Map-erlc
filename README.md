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

## Keeping the site awake
Render's free plan puts the site to sleep after ~15 minutes with no visitors. The server now **pings itself every 10 minutes**
(`/healthz`) using the address Render provides, so it stays awake while it is running. Nothing to set up.
- Change how often: `KEEPALIVE_MINUTES` (max 14). Turn off: `KEEPALIVE=0`.
- A site that is *already asleep* can't wake itself. For extra safety, add a free outside pinger such as UptimeRobot or cron-job.org
  that opens `https://YOUR-SITE.onrender.com/healthz` every 5 minutes. It also wakes the site after a redeploy.
- Free plans have 750 running hours a month: enough for one site awake 24/7, but not two.

## Link preview
When someone posts your link in Discord, Slack, iMessage, X and so on, it shows a card with the app name, a short description and a
picture (`public/og-image.png`, 1200x630). Each server link (`/s/their-name`) shows that server's name.
- If you use your own domain, set `PUBLIC_URL=https://your-domain.com` so the card's image address is correct.
- Want a different picture? Replace `public/og-image.png` (keep it 1200x630).
- Discord remembers previews for a while. After changes, paste the link with `?v=2` on the end to see the new card.

## Website layout
- `/` landing page · `/app` the main map · `/s/NAME` a server's map (`/s/NAME/admin` its admin page)
- `/dashboard` log in with Discord, create servers, manage keys and admins · `/servers` public directory

## Discord login (one-time setup)
1. Go to https://discord.com/developers/applications and click **New Application**.
2. Open **OAuth2** and add this exact **Redirect**: `https://YOUR-SITE.onrender.com/auth/discord/callback`
   (if you use your own domain, use that domain instead, and set `PUBLIC_URL` to it).
3. Copy the **Client ID** and **Client Secret** into Render as `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
4. Add `SESSION_SECRET` (any long random text, keeps people logged in across restarts).
5. Add `OWNER_DISCORD_IDS` = your own Discord user ID (Discord: Settings > Advanced > Developer Mode, then right-click your name > Copy User ID).
   You can then open `/app/admin` for the main server just by being logged in. Separate several IDs with commas.

Without Discord set up, the site still works: servers are created with an admin password instead of a login.
Once Discord is set up, creating a server requires logging in, and the person who creates it becomes its owner.
Owners can add co-admins by Discord ID, set the ER:LC key, rename, hide or delete their server. Max 5 servers per person.
