<?php
// Jen pro lokální vývoj: php -S 127.0.0.1:3001 -t public dev-router.php
// Napodobí hosting: stejné Content-Security-Policy jako public/.htaccess a zákaz přístupu do storage/ (vestavěný server .htaccess nečte).
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(storage/|config)#', $path)) { http_response_code(403); exit; }
if ($path === '/' || str_ends_with($path, '.html')) {
  preg_match('/^\s*Header always set Content-Security-Policy "(.+)"/m', file_get_contents(__DIR__ . '/public/.htaccess'), $m);
  header('Content-Security-Policy: ' . $m[1]);
  header('Content-Type: text/html; charset=utf-8');
  readfile(__DIR__ . '/public' . ($path === '/' ? '/index.html' : $path));
  exit;
}
return false;
