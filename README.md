[![Solmar](https://make.fun/badge/gta6-01.svg)](https://make.fun/gta6-01) [![Rank](https://make.fun/badge/gta6-01/alfasurya91/solmar-open-world/rank.svg)](https://make.fun/gta6-01/alfasurya91/solmar-open-world) [![Reward](https://make.fun/badge/gta6-01/alfasurya91/solmar-open-world/reward.svg)](https://make.fun/gta6-01/alfasurya91/solmar-open-world)

# Solmar

Solmar is a two-dimensional open-world game set in a seaside town that never existed. The whole
thing is painted with the plain HTML canvas 2D API: there is no engine underneath, no build step to
run, no third-party library and no network request after the page has loaded.

The town is a grid of two-way streets around flat-roofed blocks. On its eastern edge the blocks stop
and the promenade takes over, then sand, a pier and finally open water. You begin on foot. From there
you take jobs, drive and steal cars, settle arguments with your fists or a pistol, and keep half an
eye on the wanted stars while the police close in.

## Playing

The title card comes first. Press Enter, then learn the blocks; the objective card at the top of the
screen always says where to go next. The five story jobs pull you across the map — arrive at a
marker, carry a package the last stretch on foot, run a rival courier down along the beach road — and
each one pays cash. Between jobs the town is yours: take a parked car, pull a driver out of traffic,
or find out how long you last at five stars.

Cash, health, position and story progress share one localStorage slot, rewritten automatically every
twenty seconds while you are on foot.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrow keys | Walk. In a car: `W` accelerates, `S` brakes then reverses, `A` and `D` steer |
| `Shift` | Run, on foot |
| `Space` | Handbrake in a car; also starts the game from the title card |
| `E` | Get into the nearest car, steal one out of traffic, step out, or pick up the pistol |
| `X` / left click | Punch |
| `C` / right click | Shoot, once the pistol has been found |
| `F5` | Save |
| `F9` | Load |
| `Esc` / `P` | Pause and resume |
| `Enter` | Start the game, and start again after being wasted |

## Systems

- The city grows from a seed: seven columns by five rows of blocks, from downtown out to the
  shoreline, with parks, parking lots, a promenade, sand, a pier and the sea. Every street
  coordinate is derived from the config sheet, so no other module writes one by hand.
- A day and night clock. Windows light up after dark and headlights come on.
- Traffic and crowd: 26 computer-driven cars that keep to the correct side of two-way lanes, and 54
  pedestrians circulating the block rings, the promenade and the pier.
- Vehicles: kerbside parking you can climb into, arcade handling with acceleration, braking, reverse,
  steering and a handbrake. Taking a car out of traffic counts as a crime.
- Police and heat: five wanted stars, cruisers that chase and ram, officers on foot who try to make
  an arrest and open fire from four stars up, and heat that drains once you break line of sight.
- Combat: fists and a pistol — melee swings, traced bullets, pedestrians put on the ground, muzzle
  flashes and sparks.
- Jobs: five story missions followed by a repeatable free-roam run, each with its own objective
  card, distance readout and payout.
- HUD: health bar, wanted stars, cash and clock, the objective card, a live minimap of traffic,
  parked cars and the objective marker, an interaction prompt, and a toast strip.
- One localStorage slot for saving and loading, plus autosave.
- Audio is synthesised: every effect and the music come out of WebAudio, so no asset files ship.

## Running it locally

Node 22 or newer. Nothing to install.

    node serve.ts

Then open http://localhost:8080 in a desktop browser. Pass `--port 9000` (or any free port) to serve
somewhere else.

## Project layout

    game/index.html           the page: one canvas and a status line
    game/src/main.js          boot, the fixed-step loop, screens, save/load, wiring
    game/src/config.js        the tuning sheet: city shape, speeds, palette, save key
    game/src/city.js          procedural city generation (blocks, parks, lots, beach, pier)
    game/src/render.js        the 2D renderer, including the baked ground layer
    game/src/hud.js           the drawn interface: panels, objective card, minimap, menus
    game/src/player.js        on-foot movement and collision
    game/src/vehicles.js      car physics, entering and leaving
    game/src/traffic.js       NPC traffic and lane following
    game/src/pedestrians.js   the crowd
    game/src/police.js        wanted heat, dispatch, pursuit, arrest, return fire
    game/src/combat.js        fists, pistol, bullets, particles, pickups
    game/src/missions.js      story jobs, free-roam job, objective card data
    game/src/audio.js         synthesised sound effects and music (WebAudio)
    game/src/input.js         key polling and one-shot action latching
    game/src/utils.js         arithmetic, geometry and the seeded generator
    game/src/save.js          the one localStorage slot
    serve.ts                  a static server for game/ (Node standard library only)
    main.ts                   build entry: copies game/ and screenshots/, writes dossier.json
    vendor/makefun-game.ts    the dossier writer used by main.ts

`game/src/world.js`, `game/src/random.js` and `game/src/shots.js` are leftovers from the starter kit
and are not imported by the Solmar build.

## Query hooks

- `?seed=N` builds the city again from a different seed.
- `?autostart=1` skips the title card and drops straight into free roam.
- `?shot=start|play|end` stages a single frame for the screenshot runner.

## License

MIT. See [LICENSE](LICENSE).
