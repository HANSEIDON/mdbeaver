// About page: the first time the token chart scrolls well into view the beaver pops up over its top
// edge and takes a bite: the card shakes, crumbs fly and the mdbeaver bars get gnawed down from
// the page-image length to their real length. It plays once. Without JS, or with reduced motion,
// the chart simply shows its final state.
const chart = document.querySelector(".chart");
if (chart && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  chart.classList.add("armed");
  const crumbs = chart.querySelector(".crumbs");
  for (let k = 0; k < 12; k++) {
    const c = document.createElement("i");
    const angle = Math.PI * (0.15 + Math.random() * 0.7); // up and out to both sides
    const dist = 40 + Math.random() * 70;
    c.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    c.style.setProperty("--dy", `${-Math.sin(angle) * dist * 0.6 + 50 + Math.random() * 40}px`);
    c.style.setProperty("--r", `${Math.round(Math.random() * 540 - 270)}deg`);
    c.style.setProperty("--s", (0.6 + Math.random() * 0.8).toFixed(2));
    crumbs.append(c);
  }
  // Plays once, the first time the chart's top passes 65% of the window height.
  const check = () => {
    const r = chart.getBoundingClientRect();
    if (r.top < innerHeight * 0.65 && r.bottom > 80) {
      chart.classList.add("chomped");
      removeEventListener("scroll", onScroll);
    }
  };
  let raf = 0;
  const onScroll = () => { raf ||= requestAnimationFrame(() => { raf = 0; check(); }); };
  addEventListener("scroll", onScroll, { passive: true });
  check();
}
