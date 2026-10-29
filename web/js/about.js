// About page: each time the token chart scrolls well into view the beaver pops up over its top
// edge and takes three bites: the card shakes, crumbs fly and the mdbeaver
// bars get gnawed down from the page-image length to their real length. Scrolling away and back
// plays it again. Without JS, or with reduced motion, the chart simply shows its final state.
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
  // Plays once the chart's top passes 65% of the window height; resets once it is back below 70%
  // or scrolled off the top. The gap between the two keeps it from flickering at the edge.
  let raf = 0;
  const check = () => {
    raf = 0;
    const r = chart.getBoundingClientRect();
    const on = chart.classList.contains("chomped");
    if (!on && r.top < innerHeight * 0.65 && r.bottom > 80) chart.classList.add("chomped");
    else if (on && (r.top > innerHeight * 0.7 || r.bottom < 0)) chart.classList.remove("chomped");
  };
  addEventListener("scroll", () => { raf ||= requestAnimationFrame(check); }, { passive: true });
  addEventListener("resize", check);
  check();
}
