// About page: when the token chart scrolls into view the beaver pops up and takes a bite out of
// it: the card shakes, cracks run from the bite, crumbs fly and the mdbeaver bars get gnawed
// down from the page-image length to their real length. Without JS, or with reduced motion,
// the chart simply shows its final state.
const chart = document.querySelector(".chart");
if (chart && !matchMedia("(prefers-reduced-motion: reduce)").matches && "IntersectionObserver" in window) {
  chart.classList.add("armed");
  const crumbs = chart.querySelector(".crumbs");
  for (let k = 0; k < 12; k++) {
    const c = document.createElement("i");
    const angle = Math.PI * (0.55 + Math.random() * 0.9); // mostly up and to the left
    const dist = 40 + Math.random() * 70;
    c.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    c.style.setProperty("--dy", `${-Math.sin(angle) * dist * 0.6 + 50 + Math.random() * 40}px`);
    c.style.setProperty("--r", `${Math.round(Math.random() * 540 - 270)}deg`);
    c.style.setProperty("--s", (0.6 + Math.random() * 0.8).toFixed(2));
    crumbs.append(c);
  }
  new IntersectionObserver((entries, io) => {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    setTimeout(() => chart.classList.add("chomped"), 250);
  }, { threshold: 0.5, rootMargin: "0px 0px -30% 0px" }).observe(chart); // well into view, not just peeking in at the bottom
}
