# Five Nines

A browser-based Network Operations Center simulator. Keep the network at 99.999%. NetSmart gear, Cisco IOS syntax. See [ROADMAP.md](ROADMAP.md).

## Run it

```bash
npm install
npm run dev
```

## Test

```bash
npm test
```

## Layout

| Path | What lives there |
|---|---|
| `src/sim/` | The simulation engine (no UI code): devices, L1/L2 state, routing, show output |
| `src/sim/cli/` | IOS command parser and console session |
| `src/content/` | Networks and scenarios |
| `src/ui/` | React UI |
| `tests/` | Vitest tests that drive the CLI like a player would |
