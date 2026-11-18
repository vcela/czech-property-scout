<?php
// Reality na mapě – backend pro běžný PHP hosting (bez databáze, data v JSON souborech).
// Čtení je veřejné; zápis jen pro vlastníka přihlášeného magic linkem (cookie platí "navždy" – obnovuje se při každé návštěvě).
declare(strict_types=1);
set_time_limit(300);
ini_set('display_errors', '0'); // chyby do logu, ne do JSON odpovědi
if (!is_file(__DIR__ . '/config.php')) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); exit('{"error":"Chybí config.php – zkopírujte config.example.php na config.php a vyplňte svůj e-mail."}'); }
$CFG = require __DIR__ . '/config.php';
const ST = __DIR__ . '/storage';
const IMG = __DIR__ . '/img';
const COOKIE = 'rm_s';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const UA_APP = 'reality-mapa/1.0 (osobni aplikace)';

function out($data, int $code = 200): never {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}
function fail(string $msg, int $code = 400, array $extra = []): never { out(['error' => $msg] + $extra, $code); }

// --- JSON soubory se zámkem (souběžné zápisy z více záložek) ---
function jread(string $name, $default) {
  $f = ST . "/$name.json";
  return is_file($f) ? (json_decode((string)file_get_contents($f), true) ?? $default) : $default;
}
function jupdate(string $name, $default, callable $fn) {
  $f = ST . "/$name.json";
  $h = fopen($f, 'c+');
  flock($h, LOCK_EX);
  $raw = stream_get_contents($h);
  $data = $raw ? (json_decode($raw, true) ?? $default) : $default;
  $result = $fn($data);
  ftruncate($h, 0); rewind($h);
  fwrite($h, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
  fflush($h); flock($h, LOCK_UN); fclose($h);
  return $result;
}
function base_url(): string {
  $https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
  $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/');
  return ($https ? 'https' : 'http') . '://' . $_SERVER['HTTP_HOST'] . $dir . '/';
}
function cookie_path(): string { return rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/') . '/'; }
function set_session_cookie(string $sid): void {
  // prohlížeče drží cookie max ~400 dní → obnovuje se při každé návštěvě, takže v praxi odhlášení nenastane
  setcookie(COOKIE, $sid, ['expires' => time() + 400 * 86400, 'path' => cookie_path(), 'secure' => ($_SERVER['HTTPS'] ?? '') === 'on', 'httponly' => true, 'samesite' => 'Lax']);
}

// --- přihlášení ---
function is_owner(): bool {
  static $ok = null;
  if ($ok !== null) return $ok;
  $sid = $_COOKIE[COOKIE] ?? '';
  $ok = $sid !== '' && isset(jread('auth', [])['sessions'][hash('sha256', $sid)]);
  if ($ok) set_session_cookie($sid);
  return $ok;
}
function require_owner(): void {
  if (!is_owner()) fail('Pro úpravy se přihlaste', 401);
  if (($_SERVER['HTTP_X_RM'] ?? '') !== '1') fail('Chybí hlavička', 400); // ochrana proti CSRF z cizích stránek
}

// --- stažení URL (curl) ---
function http_get(string $url, int $timeout = 30, bool $browser = false, string $referer = ''): array {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5,
    CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS, CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
    CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_ENCODING => '',
    CURLOPT_USERAGENT => $browser ? UA_BROWSER : UA_APP,
    CURLOPT_HTTPHEADER => array_filter(['Accept-Language: cs,en;q=0.8', $referer ? "Referer: $referer" : null]),
  ]);
  $body = curl_exec($ch);
  $res = ['code' => (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE), 'type' => (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE), 'body' => $body === false ? '' : $body, 'error' => curl_error($ch)];
  curl_close($ch);
  return $res;
}
// jen veřejné adresy (proxy nesmí sahat do vnitřní sítě hostingu)
function public_url(string $url): bool {
  $p = parse_url($url);
  if (!$p || !in_array($p['scheme'] ?? '', ['http', 'https'], true) || empty($p['host'])) return false;
  $ips = gethostbynamel($p['host']) ?: [];
  foreach ($ips as $ip) if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) return false;
  return (bool)$ips;
}

function canonical(string $u): string {
  $p = parse_url(trim($u));
  if (!$p || !in_array($p['scheme'] ?? '', ['http', 'https'], true) || empty($p['host'])) fail('Neplatný odkaz');
  $keepQuery = !preg_match('/sreality|bezrealitky|realingo/', $p['host']);
  return $p['scheme'] . '://' . $p['host'] . ($p['path'] ?? '/') . ($keepQuery && isset($p['query']) ? '?' . $p['query'] : '');
}

function download_images(string $id, array $urls, string $referer): array {
  $dir = IMG . "/$id";
  if (is_dir($dir)) array_map('unlink', glob("$dir/*") ?: []);
  else mkdir($dir, 0775, true);
  $out = [];
  foreach (array_slice($urls, 0, 30) as $i => $u) {
    if (!is_string($u) || !public_url($u)) continue;
    $r = http_get($u, 20, true, $referer);
    if ($r['code'] !== 200 || !str_starts_with($r['type'], 'image/')) continue;
    $ext = str_contains($r['type'], 'png') ? 'png' : (str_contains($r['type'], 'webp') ? 'webp' : 'jpg');
    $name = sprintf('%02d.%s', $i, $ext);
    file_put_contents("$dir/$name", $r['body']);
    $out[] = "img/$id/$name";
  }
  return $out;
}

function body(): array { return json_decode((string)file_get_contents('php://input'), true) ?? []; }
function backup(): void { // denní záloha inzerátů (posledních 30 dní)
  $bk = ST . '/backup';
  if (!is_dir($bk)) mkdir($bk, 0775, true);
  $f = "$bk/listings-" . date('Y-m-d') . '.json';
  if (!is_file($f) && is_file(ST . '/listings.json')) copy(ST . '/listings.json', $f);
  foreach (array_slice(array_reverse(glob("$bk/listings-*.json") ?: []), 30) as $old) unlink($old);
}

// =====================================================================
$a = $_GET['a'] ?? '';
switch ($a) {
  case 'list': out(jread('listings', []));
  case 'pid': // zmenšený seznam zastávek PID; vytvoří ho prohlížeč vlastníka při první analýze (a obnoví po 30 dnech)
    if ($_SERVER['REQUEST_METHOD'] === 'POST') { require_owner(); $d = body(); if (count($d) < 100) fail('Neplatná data'); file_put_contents(ST . '/pid-stops.json', json_encode($d, JSON_UNESCAPED_UNICODE)); out(['ok' => true]); }
    $f = ST . '/pid-stops.json';
    if (!is_file($f) || time() - filemtime($f) > 30 * 86400) fail('Seznam zastávek zatím není', 404);
    header('Content-Type: application/json; charset=utf-8');
    readfile($f);
    exit;
  case 'me': out(['owner' => is_owner(), 'password' => ($CFG['password'] ?? '') !== '']);

  // ---------- přihlášení heslem (heslo je jen v config.php na serveru) ----------
  case 'login_pw':
    $pw = (string)($CFG['password'] ?? '');
    if ($pw === '') fail('Přihlášení heslem není zapnuté (v config.php chybí heslo)', 400);
    $given = (string)(body()['password'] ?? '');
    $sid = bin2hex(random_bytes(32));
    // ochrana proti hádání: po 5 chybách zámek na 15 minut
    $res = jupdate('auth', [], function (&$au) use ($pw, $given, $sid) {
      if (($au['lockUntil'] ?? 0) > time()) return 'locked';
      if (!hash_equals($pw, $given)) {
        $au['fails'] = ($au['fails'] ?? 0) + 1;
        if ($au['fails'] >= 5) { $au['lockUntil'] = time() + 900; $au['fails'] = 0; }
        return 'bad';
      }
      $au['fails'] = 0;
      $au['sessions'][hash('sha256', $sid)] = date('c');
      return 'ok';
    });
    if ($res === 'locked') fail('Příliš mnoho pokusů – zkuste to za 15 minut', 429);
    if ($res === 'bad') { usleep(800000); fail('Špatné heslo', 401); }
    set_session_cookie($sid);
    out(['ok' => true]);
  case 'settings':
    if ($_SERVER['REQUEST_METHOD'] === 'POST') { require_owner(); $w = body()['weights'] ?? null; if (!is_array($w)) fail('Chybí váhy'); jupdate('settings', [], function (&$s) use ($w) { $s['weights'] = $w; }); }
    out(jread('settings', ['weights' => null]));
  case 'reach':
    if ($_SERVER['REQUEST_METHOD'] === 'POST') { require_owner(); $d = body(); if (empty($d['cells'])) fail('Prázdná data'); file_put_contents(ST . '/reach.json', json_encode($d)); out(['ok' => true]); }
    out(jread('reach', ['status' => 'none']));

  // ---------- přihlášení magic linkem ----------
  case 'login':
    $email = strtolower(trim((string)(body()['email'] ?? '')));
    $msg = ['ok' => true, 'message' => 'Pokud je adresa oprávněná, přišel na ni odkaz pro přihlášení (platí 30 minut).'];
    if ($email !== strtolower($CFG['owner_email'])) out($msg);
    $token = bin2hex(random_bytes(32));
    $tooSoon = jupdate('auth', [], function (&$au) use ($token) {
      if (time() - ($au['lastMail'] ?? 0) < 60) return true; // max 1 e-mail za minutu
      $au['lastMail'] = time();
      $au['tokens'] = array_filter($au['tokens'] ?? [], fn($exp) => $exp > time());
      $au['tokens'][hash('sha256', $token)] = time() + 1800;
      return false;
    });
    if ($tooSoon) out($msg);
    $link = base_url() . 'api.php?a=verify&t=' . $token;
    $sent = @mail($CFG['owner_email'], mb_encode_mimeheader('Přihlášení – Reality na mapě', 'UTF-8'),
      "Pro přihlášení klikněte na odkaz (platí 30 minut, jen jednou):\n\n$link\n\nPokud jste o přihlášení nežádal, e-mail ignorujte.\n",
      "From: {$CFG['mail_from']}\r\nContent-Type: text/plain; charset=UTF-8\r\nMIME-Version: 1.0");
    // lokální vývoj (bez poštovního serveru): odkaz vrátit rovnou
    if (!$sent && in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)) out($msg + ['devLink' => $link]);
    out($msg);

  case 'verify':
    $h = hash('sha256', (string)($_GET['t'] ?? ''));
    $sid = bin2hex(random_bytes(32));
    $ok = jupdate('auth', [], function (&$au) use ($h, $sid) {
      $exp = $au['tokens'][$h] ?? 0;
      unset($au['tokens'][$h]);
      if ($exp < time()) return false;
      $au['sessions'][hash('sha256', $sid)] = date('c');
      return true;
    });
    if (!$ok) { header('Content-Type: text/html; charset=utf-8'); exit('<p style="font:16px sans-serif;padding:40px">Odkaz už neplatí. <a href="./">Zpět</a> a požádejte o nový.</p>'); }
    set_session_cookie($sid);
    header('Location: ./'); exit;

  case 'logout': // jen pro jistotu (např. cizí počítač)
    $sid = $_COOKIE[COOKIE] ?? '';
    jupdate('auth', [], function (&$au) use ($sid) { unset($au['sessions'][hash('sha256', $sid)]); });
    setcookie(COOKIE, '', ['expires' => 1, 'path' => cookie_path()]);
    out(['ok' => true]);

  // ---------- jen vlastník ----------
  case 'proxy': // prohlížeč přes server stahuje inzeráty a data z veřejných API (obchází CORS)
    require_owner();
    $u = (string)($_GET['u'] ?? '');
    if (!public_url($u)) fail('Nepovolená adresa');
    $r = http_get($u, min(120, max(5, (int)($_GET['t'] ?? 30))), ($_GET['ua'] ?? '') === 'b');
    if ($r['code'] === 0) fail('Server neodpověděl: ' . $r['error'], 502);
    http_response_code($r['code']);
    header('Content-Type: ' . ($r['type'] ?: 'application/octet-stream'));
    header('X-Upstream-Status: ' . $r['code']);
    echo $r['body'];
    exit;

  case 'add':
    require_owner();
    $b = body();
    $url = canonical((string)($b['url'] ?? ''));
    $data = (array)($b['data'] ?? []);
    $dup = null;
    foreach (jread('listings', []) as $l) if ($l['url'] === $url) $dup = $l['id'];
    if ($dup) fail('Tento inzerát už máte uložený', 409, ['id' => $dup]);
    $id = substr(sha1($url), 0, 10);
    $data['imagesLocal'] = download_images($id, (array)($data['images'] ?? []), $url);
    $l = array_merge($data, ['id' => $id, 'url' => $url, 'addedAt' => date('c'), 'updatedAt' => date('c'), 'rating' => 0, 'status' => 'nový', 'note' => '',
      'geo' => ['status' => !empty($data['lat']) ? 'pending' : 'nopos']]);
    backup();
    jupdate('listings', [], function (&$list) use ($l) { array_unshift($list, $l); });
    out($l, 201);

  case 'update': // úpravy od vlastníka: hodnocení, stav, poznámka, opravy vybavení, poloha, výsledek analýzy, znovu načtený inzerát
    require_owner();
    $b = body();
    $id = (string)($b['id'] ?? '');
    $p = (array)($b['patch'] ?? []);
    if (isset($p['images'])) {
      $ref = ''; foreach (jread('listings', []) as $x) if ($x['id'] === $id) $ref = $x['url'];
      $p['imagesLocal'] = download_images($id, (array)$p['images'], $ref);
    }
    $res = jupdate('listings', [], function (&$list) use ($id, $p) {
      foreach ($list as &$l) {
        if ($l['id'] !== $id) continue;
        $keep = ['manualPosition' => $l['manualPosition'] ?? null, 'featureOverrides' => $l['featureOverrides'] ?? null];
        foreach ($p as $k => $v) if (!in_array($k, ['id', 'url', 'addedAt', 'features', 'featureOverrides'], true)) $l[$k] = $v;
        if (isset($p['features'])) $l['featureOverrides'] = array_merge($keep['featureOverrides'] ?? [], $p['features']);
        if (isset($p['lat'], $p['manual'])) { $l['manualPosition'] = ['lat' => $p['lat'], 'lng' => $p['lng'], 'locPrecision' => 'ručně']; $l['locPrecision'] = 'ručně'; unset($l['manual']); }
        elseif (isset($p['refreshed'])) { // znovu načteno z webu: ruční poloha a opravy mají přednost
          if ($keep['manualPosition']) $l = array_merge($l, $keep['manualPosition']);
          unset($l['refreshed']);
        }
        $l['updatedAt'] = date('c');
        return $l;
      }
      return null;
    });
    $res ? out($res) : fail('Inzerát nenalezen', 404);

  case 'delete':
    require_owner();
    $id = (string)(body()['id'] ?? '');
    if (!preg_match('/^[a-f0-9]{10}$/', $id)) fail('Neplatné id');
    backup();
    jupdate('listings', [], function (&$list) use ($id) { $list = array_values(array_filter($list, fn($l) => $l['id'] !== $id)); });
    if (is_dir(IMG . "/$id")) { array_map('unlink', glob(IMG . "/$id/*") ?: []); rmdir(IMG . "/$id"); }
    out(['ok' => true]);

  default: fail('Neznámá akce', 404);
}
