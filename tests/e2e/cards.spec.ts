import { test, expect } from "@playwright/test";
test("all 54 faces use large centered ranks without clipping", async ({
  page,
  request,
}) => {
  const faces: { name: string; label: string; svg: string }[] = [];
  for (const suit of ["spades", "hearts", "diamonds", "clubs"])
    for (let rank = 1; rank <= 13; rank++) {
      const name = `${suit}-${rank}`;
      faces.push({
        name,
        label:
          ({ 1: "A", 11: "J", 12: "Q", 13: "K" } as Record<number, string>)[
            rank
          ] ?? String(rank),
        svg: await (await request.get(`/cards/${name}.svg`)).text(),
      });
    }
  for (const name of ["joker-black-0", "joker-red-0"])
    faces.push({
      name,
      label: "0",
      svg: await (await request.get(`/cards/${name}.svg`)).text(),
    });
  await page.setContent(
    `<style>body{background:#163e33;display:flex;flex-wrap:wrap;gap:12px;font-family:sans-serif}figure{margin:0;color:#eedfb0}svg{display:block}</style>` +
      faces
        .map(
          (f) =>
            `<figure data-name="${f.name}">${f.svg}<figcaption>${f.name}</figcaption></figure>`,
        )
        .join(""),
  );
  const measured = await page.locator("figure").evaluateAll((figures) =>
    figures.map((f) => {
      const svg = f.querySelector("svg")!;
      const central = [...svg.querySelectorAll("text")].find(
        (t) => Number(t.getAttribute("font-size")) >= 80,
      )!;
      const b = central.getBBox();
      return {
        name: f.getAttribute("data-name"),
        rank: central.textContent,
        viewBox: svg.getAttribute("viewBox"),
        center: central.getAttribute("x"),
        left: b.x,
        right: b.x + b.width,
        top: b.y,
        bottom: b.y + b.height,
      };
    }),
  );
  expect(measured).toHaveLength(54);
  for (const [i, m] of measured.entries()) {
    expect(m.rank).toBe(faces[i].label);
    expect(m.center).toBe("70");
    expect(m.viewBox).toBe("0 0 140 196");
    expect(m.left, m.name!).toBeGreaterThan(1);
    expect(m.right, m.name!).toBeLessThan(139);
    expect(m.top).toBeGreaterThan(1);
    expect(m.bottom).toBeLessThan(195);
  }
  await page.locator("figure").evaluateAll((figures) =>
    figures.forEach((f) => {
      if (
        ![
          "spades-1",
          "hearts-10",
          "clubs-11",
          "diamonds-12",
          "spades-13",
          "joker-black-0",
          "joker-red-0",
        ].includes(f.getAttribute("data-name")!)
      )
        f.remove();
    }),
  );
  await page.screenshot({
    path: `artifacts/card-faces-${test.info().project.name}.png`,
    fullPage: true,
  });
});
