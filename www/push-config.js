// Push server settings - filled in after `wrangler deploy`
// (see push-server/README.md). Empty values keep web push OFF: everything
// else in the app works normally without it.
window.RK_PUSH = {
  api: '',            // e.g. "https://rk-push.<your-subdomain>.workers.dev"
  vapidPublicKey: ''  // printed by `node gen-keys.js`
};
