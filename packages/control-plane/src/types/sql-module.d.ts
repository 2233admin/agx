// Bun embeds `*.sql with { type: 'text' }` imports as plain strings at
// bundle/compile time (see repository.ts/launch-repository.ts for why this
// is required over a runtime `readFileSync` path in a `bun build --compile`
// standalone executable). `bun-types` ships wildcard ambient declarations
// for `.txt`/`.toml`/`.yaml`/etc. (see `extensions.d.ts`) but not `.sql`.
declare module '*.sql' {
  const content: string;
  export default content;
}
