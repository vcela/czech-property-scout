# Czech Property Scout

*Reality na mapě – osobní evidence nemovitostí s analýzou vody, záplav a dopravy.*

> **EN:** Personal real-estate tracker for Czechia. Paste a listing URL from Sreality, Bezrealitky, iDNES Reality or Realingo, and the app saves its details and photos and analyses the surroundings: distance to water, flood zones, train and bus stops, supermarkets, travel time to Prague and Pilsen by car, train and bus, plus an automatic 0–100 score with adjustable weights. Plain PHP and JavaScript, no database or build step, so it runs on cheap shared hosting. MIT licensed.

Vložíte odkaz na inzerát a aplikace načte údaje a fotky a vyhodnotí okolí nemovitosti. Je určená hlavně pro hledání domů, chat a chalup. 

## Co umí

- **Načtení inzerátu** ze Sreality, Bezrealitek, iDNES Reality a Realinga (agregátor vč. Bazoše). Ostatní weby načte jen základně: název, fotku a popis.
- **Fotky** se stáhnou na váš server, takže zůstanou, i když inzerát zmizí.
- **Vybavení** se pozná z parametrů a z textu inzerátu: vlastní pozemek (pronájem a „pozemek jen pod stavbou“ se zvlášť označí), garáž, studna nebo vodovod, elektřina, odpad a plyn. Ručně jde opravit.
- **Voda:**
  - vzdálenost k nejbližší vodě a k řece,
  - mapa se zvýrazněnými potoky a rybníky (ČÚZK ZABAGED),
  - oficiální záplavová území Q5–Q500.
- **Doprava:**
  - nejbližší vlak a autobus i s čísly linek,
  - cesta do centra Prahy a Plzně autem, vlakem a autobusem podle skutečných jízdních řádů,
  - nejbližší supermarkety.
- **Mapa „Kde je dobré spojení“** ukazuje oblasti, odkud se veřejnou dopravou rychle dostanete do Prahy, do Plzně, nebo do obou měst.
- **Automatické hodnocení 0–100** s rozpisem, proč nemovitost dostala tolik bodů. Váhy kritérií nastavíte šoupátky.
- **Vlastní hodnocení** hvězdičkami, stav (zajímavý / na prohlídku / zamítnutý), poznámky, filtry a řazení.
- **Přihlášení** magic linkem poslaným e-mailem; upravovat může jen vlastník. Návštěvníci se mohou dívat, ale nic nezmění.

## Instalace (běžný PHP hosting)

Potřebujete PHP 8.1+ s rozšířením `curl` a funkcí `mail()` (má je většina hostingů). Databáze ani Node.js nejsou potřeba.

1. Stáhněte repozitář a obsah složky **`public/`** nahrajte na hosting do složky, kde má aplikace běžet (např. `www/reality/`). Nahrajte i skryté soubory `.htaccess`.
2. Na serveru zkopírujte `config.example.php` na **`config.php`** a vyplňte:
   - `owner_email` – váš e-mail, jediný, který se může přihlásit,
   - `mail_from` – odesílatel e-mailu s odkazem pro přihlášení (adresa na doméně hostingu, jinak e-mail skončí ve spamu).
   - `password` – heslo pro přihlášení bez e-mailu (doporučeno, pokud hosting e-maily nedoručuje). Prázdné = vypnuto. Po 5 špatných pokusech se přihlášení na 15 minut zamkne.
3. Složky `storage/` a `img/` musí mít PHP právo zápisu (obvykle to platí rovnou; jinak práva 775).
4. Otevřete aplikaci v prohlížeči, klikněte na **Přihlásit** a zadejte heslo (nebo si nechte poslat odkaz e-mailem).
5. Ověřte, že `…/storage/listings.json` i `…/config.php` vracejí **403**, tedy že vaše data nejsou volně čitelná.

Přihlášení vydrží. Cookie se obnovuje při každé návštěvě a vyprší až po zhruba 13 měsících bez návštěvy.

## Lokální spuštění

```bash
cp public/config.example.php public/config.php
```
```bash
php -S 127.0.0.1:3001 -t public dev-router.php
```

Otevřete http://127.0.0.1:3001. Soubor `dev-router.php` napodobí hosting (stejná bezpečnostní hlavička jako `.htaccess`, zákaz přístupu do `storage/`). Lokálně obvykle chybí poštovní server; aplikace pak odkaz pro přihlášení zobrazí rovnou na stránce. Funguje to jen z adresy 127.0.0.1.

Test výpočtů (hodnocení, rozpoznání vybavení, geometrie): `node test.js`

## Jak to funguje

```
public/
  index.html, app.js, style.css   rozhraní (Leaflet mapa)
  scrape.js                        čtení inzerátů z realitních webů
  geo.js                           analýza okolí (voda, záplavy, doprava, obchody)
  reach.js                         mapa „Kde je dobré spojení“
  score.js                         automatické hodnocení 0–100
  api.php                          server: ukládání, fotky, přihlášení, proxy na veřejná API
  config.example.php               šablona nastavení
  vendor/                          Leaflet (BSD-2) a písmo Montserrat Alternates (OFL) – přibalené, bez externích CDN
  storage/                         data (JSON) – neveřejné, mimo git
  img/                             stažené fotky – mimo git
```

- Načítání inzerátů a analýza okolí běží **v prohlížeči přihlášeného vlastníka**. Server jen ukládá výsledky, stahuje fotky a přeposílá dotazy na veřejná API, protože prohlížeč sám na cizí weby nesmí (CORS). Proto stačí obyčejný hosting bez cronu a dlouho běžících procesů.
- Rozpracované analýzy se dokončí při další návštěvě. Po aktualizaci aplikace se starší inzeráty samy přepočítají.
- Data jsou v `storage/listings.json`, denní zálohy v `storage/backup/` (30 dní).

### Co se do gitu nedostane

`config.php` (váš e-mail), celé `storage/` (inzeráty, přihlášení, zálohy) a `img/` (fotky), viz `.gitignore`. Repozitář tak může být veřejný.

## Zdroje dat

Aplikace volá veřejné služby. Při používání dodržujte jejich podmínky; jde o osobní nástroj s malým počtem dotazů.

| Údaj | Zdroj | Licence / podmínky |
|---|---|---|
| Mapa, voda, zastávky, obchody | [OpenStreetMap](https://www.openstreetmap.org) přes [Overpass API](https://overpass-api.de) a [Nominatim](https://nominatim.org) | ODbL; [pravidla Nominatimu](https://operations.osmfoundation.org/policies/nominatim/) |
| Zvýrazněné vodní toky a plochy | [ČÚZK – ZABAGED](https://geoportal.cuzk.cz) | otevřená data ČÚZK |
| Záplavová území, vodní útvary | [VÚV T. G. Masaryka](https://www.vuv.cz) | otevřená data VÚV |
| Zastávky a linky PID | [PID – otevřená data](https://pid.cz/o-systemu/opendata/) | dle podmínek PID |
| Cesta vlakem/autobusem, mapa spojení | [Transitous](https://transitous.org) (komunitní, MOTIS) | [pravidla používání](https://transitous.org/doc/) |
| Cesta autem | [OSRM](https://project-osrm.org) demo server | jen pro nenáročné použití |
| Podkladové mapy | OSM, OpenTopoMap, Esri, OpenRailwayMap | dle poskytovatelů |

Data z realitních serverů patří jejich provozovatelům. Aplikace je určená pro osobní evidenci inzerátů, které si uživatel sám vybere, ne pro hromadné stahování.

## Licence

[MIT](LICENSE). Kód můžete volně používat, upravovat i šířit.
