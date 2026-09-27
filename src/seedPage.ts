// The page a token-holding browser opens: /signalk-autologin/seed#token=…&next=…
//
// The token travels in the URL fragment because a fragment never leaves the
// browser. As a query string it would reach the server's request log — and
// with it `signalk bug-report` bundles that get attached to public issues.
// The page removes the fragment from the address bar and history before
// anything else, POSTs the token in an Authorization header, and on success
// the response sets the httpOnly session cookie. `next` is held to the same
// same-origin rule as safeNextPath() on the server, since the redirect here
// happens in the browser.
//
// String.raw keeps the regex backslashes literal; the script contains no
// `${`, so nothing in it is interpolated.
export const SEED_PAGE = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signing in…</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center;
         justify-content: center; background: #10161c; color: #c9d4de;
         font: 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
</style>
</head>
<body>
<p id="msg">Signing in…</p>
<script>
(function () {
  var params = new URLSearchParams(location.hash.slice(1));
  var token = params.get('token') || '';
  var next = params.get('next') || '/';
  if (next.length > 2048 || !/^\/(?![\/\\])[^\\\u0000-\u001f\u007f]*$/.test(next)) {
    next = '/';
  }
  history.replaceState(null, '', location.pathname + location.search);
  var msg = document.getElementById('msg');
  if (!token) {
    msg.textContent = 'No sign-in token in the address.';
    return;
  }
  var attempts = 0;
  // No answer, or a 5xx (the server, or a proxy in front of it, restarting):
  // keep trying for a minute.
  function retry(finalMessage) {
    if (++attempts < 20) {
      msg.textContent = 'Waiting for the Signal K server…';
      setTimeout(attempt, 3000);
    } else {
      msg.textContent = finalMessage;
    }
  }
  function attempt() {
    fetch('/signalk-autologin/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Authorization: 'Bearer ' + token }
    }).then(function (res) {
      if (res.status === 204) {
        location.replace(next);
      } else if (res.status >= 500) {
        retry('The Signal K server answered HTTP ' + res.status + '.');
      } else if (res.status === 401) {
        msg.textContent = 'Sign-in token rejected (HTTP 401).';
      } else {
        msg.textContent = 'Sign-in failed (HTTP ' + res.status + ').';
      }
    }, function () {
      retry('The Signal K server is not reachable.');
    });
  }
  attempt();
})();
</script>
</body>
</html>
`
