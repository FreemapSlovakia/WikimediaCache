# Zrýchlenie `/pictures` (bbox dopyt) — na neskôr

Stav k 9. 9. 2026. Nie je to súrne; urobiť, keď nebude nič lepšie.

## Čo je pomalé a prečo

```sql
SELECT page_id, ST_X(location) AS lon, ST_Y(location) AS lat
FROM wikimedia_photo
WHERE location && ST_MakeEnvelope($1, $2, $3, $4, 4326)
ORDER BY page_id DESC
LIMIT 5000
```

`ORDER BY page_id DESC` znamená, že Postgres musí cez GiST index nájsť **všetky**
riadky v obálke, prečítať ich z tabuľky a zoradiť, a až potom vziať 5000.
Pri veľkej obálke (celé Slovensko, husté z8 dlaždice) je to sekunda až dve
na dopyt, bez ohľadu na prenos.

Namerané 9. 9. 2026 (z Macu, gzip už zapnutý na nginx):

| bbox | bodov | bez gzip | gzip | čas |
|---|---|---|---|---|
| celé Slovensko 16.8,47.7,22.6,49.7 | 5000 (orezané) | 265 kB | 47 kB | 1,0–1,2 s |
| Bratislava 17.0,48.0,17.4,48.3 | 5000 (orezané) | 264 kB | 45 kB | 0,25–0,35 s |
| stredné Slovensko 18.5,48.5,19.0,48.9 | 1356 | 69 kB | 14 kB | 0,15–0,2 s |

Z telefónu (Xiaomi, WiFi, 12 dlaždíc z8 po jednej, 4 súbežne): priemer
560–680 ms na dopyt, najhustejšie dlaždice 2,2–2,3 s, gzip na tom nič
nezmenil — čas je v databáze, nie v prenose.

## Ako to appka používa (aby zmena nič nerozbila)

- Pod zoomom zhlukovania (z < 12) appka berie odpoveď ako **vzorku**: 5000
  bodov „náhodne" po ploche stačí na zhluky. Poradie podľa `page_id` je
  priestorovo náhodné, a to je vlastnosť, ktorú treba zachovať — poradie
  z GiST indexu (bez `ORDER BY`) by dalo priestorovo zhluknutý výsek, čo je
  na mape vidieť.
- Nad z12 appka plnú odpoveď (5000) berie ako orezanú a obálku štvrtí do
  hĺbky 2, kým sa výsledok nezmestí. Strop 5000 ostáva v `README.md`.
- Dopyty idú po dlaždiciach mriežky (z8–z13), 4 naraz; každá dlaždica sa
  sťahuje raz a drží sa v keši appky.

**Meranie z backendu Freemapu (Martin, 9. 9. 2026, MariaDB, tá istá štruktúra:
priestorový index + LIMIT 5000):** `LIMIT 5000` bez `ORDER BY` skončí, len čo
sken indexu dá 5000 riadkov — 34 ms, 5000 prečítaných riadkov. S `ORDER BY`
(u nás `page_id DESC`) sa prečíta celá obálka (657 000 riadkov) a triedi —
3 570 ms. Náš 1 s pre Slovensko je presne tento tvar. Bez `ORDER BY` by to bolo
~100× rýchlejšie, ale výber je v poradí R-stromu, teda priestorovo zhluknutý —
pre mapu najhoršia možná „vzorka". Preto stojí za to skúsiť možnosť 2 nižšie:
index na náhodnom stĺpci, po ktorom sa dá skenovať v poradí a skončiť po 5000
zásahoch (rýchle pri veľkej obálke, kde zasiahne skoro každý riadok; pri malej
obálke nech plánovač siahne po GiST).

## Možnosti (od najlacnejšej)

1. **Väčší strop alebo `limit` v parametri.** 5000 bodov je 45 kB s gzipom;
   `limit=20000` by nad z12 ušetril štvrtenie (4× menej dopytov). Triedenie
   to nezrýchli, ale zníži počet dopytov.
2. **Lacnejšia vzorka bez triedenia celej obálky.** Napr. stĺpec `rnd`
   (`double`, náhodné číslo pri importe) a `ORDER BY rnd LIMIT n` nič
   nezmení na cene — stále sort. Čo pomôže: `WHERE rnd < p` s `p` odvodeným
   od očakávanej hustoty (odhad cez `reltuples` alebo hrubá mriežka počtov)
   a až potom `LIMIT`; sort odpadne, GiST filter ostane. Vzorka ostane
   priestorovo rovnomerná.
3. **Predpočítané dlaždice.** Pri importe dumpu vygenerovať pre z8–z11 na
   každú dlaždicu hotový JSON/protobuf s vzorkou (5000) alebo so všetkým,
   uložiť na disk a servírovať staticky cez nginx (cache-friendly, etag).
   Appka už dopytuje po dlaždiciach mriežky, prechod je jednoduchý: nový
   endpoint `/tiles/{z}/{x}/{y}` a v appke `fetchWikimediaPhotos` pre
   `range.count == 1`. Najrýchlejšie, ale najviac roboty; obnova raz
   mesačne s dumpom.
4. **Protobuf ako v galérii Freemapu** (`pictures.proto`: delta sint32
   mikrostupne). Namerané 11. 9. 2026 na Bratislave, 5 000 bodov: JSON
   53 B/bod (265 kB), po gzipe 8,7 B (45 kB); protobuf odhad 9,4 B/bod
   (46 kB), po gzipe 4,2 B (20 kB) — teda ~2× menej na drôte a žiadne
   parsovanie 265 kB JSON-u v telefóne. Dekodér v appke už je
   (`lib/api/gallery_protobuf.dart`), wiki body (`source=1`) zatiaľ zámerne
   preskakuje — pridať vetvu. **Rozhodnuté: spraviť, ale až po zrýchlení
   dopytu (bod 2)** — čas je dnes v databáze, nie v prenose. Na strane OSM
   API je rovnaký formát hotový (`freemap-osm-api`, vetva `pb-format`,
   `proto/features.proto`), dá sa od neho odpísať kódovanie v Node.

Bod 1 + 2 sú hodina roboty, bod 3 je popoludnie. `/status` má vlastný
problém: `getCacheDirStats()` prechádza celý adresár náhľadov a pri
veľkom cache trvá nad 60 s (nginx vráti 504) — počet a veľkosť držať
v pamäti a len aktualizovať pri zápise/mazaní.
