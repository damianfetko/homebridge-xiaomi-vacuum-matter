# homebridge-xiaomi-vacuum-matter

Homebridge 2.5+ plugin, ktorý sprístupní robotický vysávač **Xiaomi Robot Vacuum X20+** (`xiaomi.vacuum.c102gl`, Dreame platforma) v Apple Home ako **natívny Matter robotický vysávač** (Matter device type 0x74 – Robotic Vacuum Cleaner).

* Komunikácia s vysávačom je **výhradne lokálna** (šifrovaný miIO protokol, UDP 54321). Žiadny Xiaomi cloud.
* Vysávač dostane v Apple Home vlastnú dlaždicu vysávača (iOS / HomePod / Apple TV s iOS 18.4+): štart, stop, pauza, návrat do doku, režimy čistenia, výber miestností, batéria, chyby, Siri.

## Čo plugin podporuje

| Funkcia v Apple Home | Matter cluster | Vysávač (MIoT) |
|---|---|---|
| Zapnúť / vypnúť (štart / stop + návrat do doku) | RvcRunMode | `2.1` start, `4.2` stop, `3.1` dock |
| Pauza / pokračovať / domov | RvcOperationalState | `2.2`, `2.1`, `4.2`+`3.1` |
| Stav: čistí, pauza, vracia sa, nabíja, v doku, vyprázdňuje kôš, umýva mop, plní vodu, mapuje | RvcOperationalState | `2.1`, `3.2`, `3.1` |
| Chyby (zaseknutý, plný kôš, prázdna nádrž, chýba mop, zaseknuté kefy/kolesá, senzory, …) | RvcOperationalState.operationalError | `2.2` (≈ 130 kódov) |
| 11 režimov čistenia (typ + sací výkon + voda) | RvcCleanMode (+ DirectModeChange) | `4.23`, `2.3`, `4.5` |
| Výber miestností | ServiceArea | `4.1` segment clean (`{"selects":…}`) |
| Batéria, nabíjanie | PowerSource | `3.1`, `3.2` |
| Identifikácia („Nájsť“) | Identify | `7.1` |
| *voliteľne:* Vyprázdniť kôš, Umyť mop, Sušiť mop, Nájsť vysávač | OnOff (zásuvky na Matter bridge) | `2.4`, `2.6`, `2.8`/`2.9`, `7.1` |

Režimy čistenia (číslo režimu je stabilné – môžeš ho použiť v automatizáciách):

| # | Režim | Typ | Sanie | Voda |
|---|---|---|---|---|
| 1 | Vysávanie – tiché | vysávanie | tiché | – |
| 2 | Vysávanie – štandard | vysávanie | štandard | – |
| 3 | Vysávanie – silné | vysávanie | silné | – |
| 4 | Vysávanie – turbo | vysávanie | turbo | – |
| 10 | Mopovanie – málo vody | mopovanie | – | nízka |
| 11 | Mopovanie – stredne | mopovanie | – | stredná |
| 12 | Mopovanie – veľa vody | mopovanie | – | vysoká |
| 20 | Vysávanie a mopovanie | oboje | štandard | stredná |
| 21 | Vysávanie a mopovanie – tiché | oboje | tiché | nízka |
| 22 | Vysávanie a mopovanie – hĺbkové | oboje | turbo | vysoká |
| 30 | Najprv vysávať, potom mopovať | postupne | štandard | stredná |

Ak nastavenie zmeníš v aplikácii Xiaomi Home, plugin v Apple Home zobrazí najbližší režim. Počas čistenia sa dá meniť sanie a voda, typ čistenia len keď robot nečistí (to je obmedzenie robota).

## Požiadavky

* Homebridge **2.5.0+** (Node.js 22.12+ / 24 / 26), Matter zapnutý pre bridge, na ktorom plugin beží.
* Apple Home s domácim centrom (HomePod / Apple TV) s iOS/tvOS 18.4+ (podpora Matter vysávačov).
* IP adresa vysávača (odporúčam statický DHCP lease) a token.

## Inštalácia

```bash
sudo npm install -g ./homebridge-xiaomi-vacuum-matter-1.0.1.tgz
```

(Na Homebridge oficiálnom obraze / `hb-service` inštalácii spusti tento príkaz v termináli Homebridge UI; súbor `.tgz` tam najprv nahraj.)

Potom v Homebridge UI:

1. **Plugins → Xiaomi Vacuum Matter → Settings** – vyplň vysávač (IP, token, miestnosti).
2. **Child Bridge Settings** – zapni child bridge a **Enable Matter** (vyber voľný port, napr. 5560). Ak chceš doplnkové prepínače, Matter bridge nesmie byť v režime „externals only“.
3. Reštartuj. V logu (a na stránke pluginu) sa zobrazí **samostatný párovací kód pre vysávač** (`Commissioning codes for <meno>`) – Apple Home vyžaduje, aby bol vysávač samostatné Matter zariadenie, nie súčasť bridge.
4. Apple Home → **+** → Pridať príslušenstvo → naskenuj QR / zadaj 11-miestny kód. Upozornenie „necertifikované príslušenstvo“ je pri Homebridge normálne.

Pôvodný vysávač v `homebridge-miot` odporúčam z konfigurácie odstrániť, aby sa nezobrazoval dvakrát.

## Konfigurácia

```json
{
  "platform": "XiaomiVacuumMatter",
  "name": "Xiaomi Vacuum Matter",
  "devices": [
    {
      "name": "Vysávač",
      "ip": "192.168.1.50",
      "token": "<32 hex znakov>",
      "deviceId": "123456789",
      "language": "sk",
      "rooms": [
        { "id": 1, "name": "Obývačka", "areaType": "LivingRoom" },
        { "id": 2, "name": "Kuchyňa", "areaType": "Kitchen" },
        { "id": 3, "name": "Spálňa", "areaType": "Bedroom" }
      ],
      "idleAction": "dock",
      "roomRepeats": 1,
      "directModeChange": true,
      "pollInterval": 15,
      "activePollInterval": 4,
      "extraSwitches": { "autoEmpty": true, "washMop": true, "dryMop": true, "locate": false }
    }
  ],
  "_bridge": {
    "username": "0E:4C:7A:11:22:33",
    "port": 51850,
    "matter": { "port": 5560 }
  }
}
```

| Kľúč | Popis |
|---|---|
| `ip`, `token` | povinné; `deviceId` je voliteľné (kontrola) |
| `language` | `sk` / `en` – názvy režimov v Apple Home |
| `rooms` | miestnosti pre výber v Apple Home (`id` = ID segmentu na mape robota). Bez nich sa výber miestností nezobrazí. `areaType` určuje typ miestnosti (napr. `LivingRoom`, `Kitchen`, `Bedroom`, `Bathroom`, `Hallway`, `Office`, `KidsRoom`, `Toilet`, `DiningRoom` → `Dining`, …) |
| `idleAction` | čo urobí „vypnutie“ počas čistenia: `dock` (stop + domov, predvolené), `stop`, `pause` |
| `roomRepeats` | počet prechodov na miestnosť (1–3) |
| `directModeChange` | dovoliť meniť sanie/vodu počas čistenia (predvolene áno) |
| `pollInterval` / `activePollInterval` | interval čítania stavu v sekundách (nečinný / čistí) |
| `extraSwitches` | doplnkové Matter zásuvky na bridge pre funkcie stanice |

### Ako zistiť ID miestností

Mapa s názvami miestností je uložená iba v cloude Xiaomi, lokálne sa nedá prečítať – preto sa miestnosti zadávajú v konfigurácii. ID segmentov sú malé čísla (1, 2, 3, …) priradené v poradí, v akom robot miestnosti vytvoril. Overíš ich diagnostickým nástrojom – robot pôjde upratovať danú miestnosť:

```bash
xvm-cli --ip 192.168.1.50 --token <token> room 3
```

```bash
xvm-cli --ip 192.168.1.50 --token <token> stop
```

```bash
xvm-cli --ip 192.168.1.50 --token <token> dock
```

## Diagnostický nástroj `xvm-cli`

```bash
xvm-cli --ip 192.168.1.50 --token <token> status
```

Ďalšie príkazy: `info`, `start`, `pause`, `resume`, `stop`, `dock`, `locate`, `empty`, `wash`, `dry`, `stopdry`, `room <id…>`, `suction <0-3>`, `water <1-3>`, `type <sweep|mop|both|mopaftersweep>`, `raw <metóda> [json]`.

## Vývoj a testy

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

End-to-end test s Matter kontrolérom (spáruje sa s vysávačom publikovaným Homebridge, ako Apple Home; `--move` robota reálne naštartuje, pozastaví, obnoví a pošle domov):

```bash
node test/e2e/matter-e2e.mjs --port <matter port vysávača> --passcode <passcode> --discriminator <discriminator> [--move --clean-mode 2]
```

Sledovanie prevádzkového stavu a chýb tak, ako ich vidí Matter kontrolér (každé 3 s):

```bash
node test/e2e/watch-errors.mjs --port <matter port vysávača> --passcode <passcode> --discriminator <discriminator> --count 20
```

## Poznámky

* Ak robot pri štarte hlási chybu „Clean water tank empty“ (kód 107), stanica nemá vodu na umytie mopu – v Apple Home sa zobrazí chyba „prázdna nádrž na vodu“. Režimy „Vysávanie“ vodu nepotrebujú.
* Plugin nepoužíva cloud, takže nemá prístup k mape, histórii čistení ani k aktualizáciám firmvéru.
