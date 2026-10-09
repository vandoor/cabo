import { mkdir, writeFile } from "node:fs/promises";
const base = new URL("../apps/web/public/", import.meta.url);
await mkdir(new URL("cards/", base), { recursive: true });
await mkdir(new URL("icons/", base), { recursive: true });
const symbols = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" };
const shell = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="196" viewBox="0 0 140 196"><rect x="1" y="1" width="138" height="194" rx="12" fill="#fffdf5" stroke="#cfc9b7" stroke-width="2"/>${body}</svg>`;
for (const [suit, symbol] of Object.entries(symbols))
  for (let rank = 1; rank <= 13; rank++) {
    const color = ["hearts", "diamonds"].includes(suit) ? "#b93642" : "#18332c";
    const label = { 1: "A", 11: "J", 12: "Q", 13: "K" }[rank] ?? rank;
    const corner = `<text x="12" y="28" font-size="23" font-weight="700">${label}</text><text x="13" y="48" font-size="20">${symbol}</text>`;
    const body = `<g fill="${color}" font-family="Georgia,serif">${corner}<g transform="rotate(180 70 98)">${corner}</g><text x="70" y="116" text-anchor="middle" font-size="62">${symbol}</text>${rank > 10 ? `<text x="70" y="153" text-anchor="middle" font-size="23">${label}</text>` : ""}</g>`;
    await writeFile(new URL(`cards/${suit}-${rank}.svg`, base), shell(body));
  }
for (const [suit, color, label] of [
  ["joker-black", "#18332c", "小王"],
  ["joker-red", "#b93642", "大王"],
]) {
  await writeFile(
    new URL(`cards/${suit}-0.svg`, base),
    shell(
      `<g fill="${color}" text-anchor="middle" font-family="sans-serif"><text x="70" y="32" font-size="15" letter-spacing="2">JOKER</text><path d="M35 85L43 126H97L105 85L83 99L70 69L57 99Z"/><circle cx="35" cy="81" r="5"/><circle cx="70" cy="64" r="5"/><circle cx="105" cy="81" r="5"/><text x="70" y="153" font-size="19">${label}</text><text x="70" y="181" font-size="17">0</text></g>`,
    ),
  );
}
await writeFile(
  new URL("cards/back.svg", base),
  `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="196" viewBox="0 0 140 196"><defs><pattern id="p" width="14" height="14" patternUnits="userSpaceOnUse"><path d="M7 0L14 7L7 14L0 7Z" fill="none" stroke="#c5b37a" stroke-opacity=".23"/></pattern></defs><rect x="1" y="1" width="138" height="194" rx="12" fill="#123e35" stroke="#ccb77c" stroke-width="2"/><rect x="8" y="8" width="124" height="180" rx="7" fill="url(#p)" stroke="#c5b37a"/><path d="M70 46L105 98L70 150L35 98Z" fill="#123e35" stroke="#c5b37a"/><text x="70" y="104" text-anchor="middle" fill="#eee2b8" font-family="Georgia,serif" font-size="18" letter-spacing="1">CABO</text></svg>`,
);
const icons = {
  draw: "M7 8V4h13v16h-4 M4 8h12v16H4Z",
  discard: "M4 11h16v12H4Z M8 4l4 5 4-5 M12 2v7",
  peek: "M2 12Q12 1 22 12Q12 23 2 12Z M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0",
  spy: "M2 10h20 M5 10l3-7h8l3 7 M4 15h6v4H4Z M14 15h6v4h-6Z M10 16h4",
  swap: "M3 7h18l-4-4 M21 17H3l4 4",
  cabo: "M5 17V8a7 7 0 0 1 14 0v9 M3 17h18 M9 21h6",
  timer: "M9 2h6 M12 5v3 M12 10v5l3 2 M21 15a9 9 0 1 1-18 0a9 9 0 1 1 18 0",
  connection: "M2 8q10-9 20 0 M5 12q7-6 14 0 M8 16q4-3 8 0 M12 20h.01",
};
for (const [name, d] of Object.entries(icons))
  await writeFile(
    new URL(`icons/${name}.svg`, base),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 26" fill="none" stroke="#eee2b8" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`,
  );
console.log("Generated 54 faces, 1 back, 8 icons.");
