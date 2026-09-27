/** Static reference diagrams, independent of settings and audio state. */
export function mountPitchEnvelopeGuide(host: HTMLElement): void {
  // Both diagrams use the same level and time scales: Rate keeps the Ps→Pr slope.
  const tr = 42;
  const baseline = 35;
  const rateEnd = 50 + tr * 49 / baseline;
  const angle = Math.atan2(baseline, tr) * 180 / Math.PI;
  const parallelMark = (x: number, y: number, style: 'reference' | 'rate') =>
    `<g class="parallel-mark" transform="translate(${x} ${y}) rotate(${angle})" aria-label="Same slope">
      <rect class="parallel-mark-background" x="-7" y="-5" width="12" height="10"/>
      <path class="${style}" d="M-5 -3L-2 0L-5 3M0 -3L3 0L0 3"/></g>`;
  const axes = `<path class="axis" d="M22 14V95H172"/><path class="zero" d="M22 65H172"/>
    <text x="14" y="12">%</text><text x="12" y="69">0</text><text x="157" y="105">t →</text>`;
  host.innerHTML = `<details class="penv-shape-guide">
    <summary>PEnv Shape Guide</summary>
    <div class="penv-guide-diagrams">
      <figure><figcaption>ADSR</figcaption>
        <svg viewBox="0 0 180 120" role="img" aria-label="ADSR: P0 to Pa to Ps; Gate OFF starts Release to Pr over Tr">${axes}
          <path class="event" d="M117 18V95"/>
          <path class="time envelope-line" d="M22 65L52 22L83 49H117L159 84H172"/>
          <text x="24" y="78">P0</text><text x="47" y="16">Pa</text><text x="87" y="44">Ps</text><text x="154" y="79">Pr</text>
          <text x="17" y="109">ON</text><text x="106" y="12">OFF</text>
          <text x="32" y="91">Ta</text><text x="62" y="91">Td</text><text x="127" y="91">Tr</text>
        </svg>
      </figure>
      <figure><figcaption>OFF during Attack
        <div class="penv-release-note"><strong>Release duration</strong><span>Time: fixed Tr</span><span>Rate: same slope as Ps→Pr</span></div>
      </figcaption>
        <svg viewBox="0 0 180 120" role="img" aria-label="Gate OFF during Attack. Gray is normal ADSR. Time takes Tr; Rate keeps the Ps to Pr slope and lasts longer in this example">${axes}
          <path class="reference" d="M22 65L62 22L88 49H117L159 84H172"/>
          <path class="event" d="M50 18V95"/>
          <path class="time" d="M22 65L50 35L92 84"/>
          <path class="rate envelope-line" d="M50 35L${rateEnd} 84"/>
          <text x="25" y="78">P0</text><text x="61" y="16">Pa</text><text x="91" y="44">Ps</text><text x="152" y="79">Pr</text>
          <text x="36" y="12">OFF</text>
          <path class="axis" d="M50 98V101H92V98"/>
          <text x="65" y="114">Tr</text>
          <text class="time-marker" x="55" y="78">Time</text>
          <text class="rate-marker" x="111" y="73">Rate</text>
          <circle class="time-marker" cx="92" cy="84" r="2"/><circle class="rate-marker" cx="${rateEnd}" cy="84" r="2"/>
          ${parallelMark(138, 66.5, 'reference')}
          ${parallelMark((50 + rateEnd) / 2, 59.5, 'rate')}
        </svg>
      </figure>
    </div>
  </details>`;
}
