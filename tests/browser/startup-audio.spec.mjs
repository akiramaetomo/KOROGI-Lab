import { test, expect } from '@playwright/test';

async function exposeAppOutput(page) {
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) {
        super(...args);
        window.__startupAudioContext = this;
      }
      createDynamicsCompressor() {
        const node = super.createDynamicsCompressor();
        window.__startupAudioOutput = node;
        return node;
      }
    };
  });
}

async function installPeakMeter(page) {
  await page.evaluate(() => {
    const analyser = window.__startupAudioContext.createAnalyser();
    analyser.fftSize = 1024;
    window.__startupAudioOutput.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    window.__startupAudioPeak = () => {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      return peak;
    };
  });
}

test('Initial Standard produces audio from the first Play without Init', async ({ page }) => {
  await exposeAppOutput(page);
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await expect(page.locator('#name-1')).toHaveValue('Standard');
  await installPeakMeter(page);

  await page.locator('#play-1').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__startupAudioPeak()), {
    timeout: 3_000,
    intervals: [50]
  }).toBeGreaterThan(0.0001);
  await page.locator('#play-1').click();
});

test('Initial Standard produces audio from the first held TRG without Init', async ({ page }) => {
  await exposeAppOutput(page);
  await page.goto('/');
  await expect(page.locator('#gate-1')).toBeEnabled();
  await installPeakMeter(page);

  const gate = await page.locator('#gate-1').boundingBox();
  await page.mouse.move(gate.x + gate.width / 2, gate.y + gate.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.__startupAudioPeak()), {
    timeout: 3_000,
    intervals: [50]
  }).toBeGreaterThan(0.0001);
  await page.mouse.up();
});

test('Initial Standard produces audio from the first held header Trigger without Init', async ({ page }) => {
  await exposeAppOutput(page);
  await page.goto('/');
  await expect(page.locator('#trigger')).toBeEnabled();
  await installPeakMeter(page);

  const trigger = await page.locator('#trigger').boundingBox();
  await page.mouse.move(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.__startupAudioPeak()), {
    timeout: 3_000,
    intervals: [50]
  }).toBeGreaterThan(0.0001);
  await page.mouse.up();
});

test('Audio status uses stable user-facing labels at tablet landscape width', async ({ page }) => {
  await exposeAppOutput(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#status')).toHaveText(/Audio (ready|running)/);

  await page.locator('#play-1').click();
  await expect(page.locator('#status')).toHaveText('Audio running');
  await page.locator('#play-1').click();
});

test('Touch pointerup retries a resume that pointerdown could not authorize', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor(...args) {
          super(...args);
          this.__lockedForTouch = true;
          this.__firstResume = null;
          window.__touchResumeAttempts = 0;
        }
        get state() { return this.__lockedForTouch ? 'suspended' : super.state; }
        resume() {
          window.__touchResumeAttempts += 1;
          if (window.__touchResumeAttempts === 1) {
            return new Promise((resolve, reject) => { this.__firstResume = { resolve, reject }; });
          }
          this.__lockedForTouch = false;
          return super.resume().then(() => {
            this.__firstResume?.resolve();
            this.__firstResume = null;
          }, error => {
            this.__firstResume?.reject(error);
            this.__firstResume = null;
            throw error;
          });
        }
      };
    });
    await page.goto('/');
    await expect(page.locator('#trigger')).toBeEnabled();
    await expect(page.locator('#status')).toHaveText('Audio ready · Tap');
    await page.locator('#trigger').tap();
    await expect(page.locator('#status')).toHaveText('Audio running');
    await expect(page.locator('#gate-1')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => window.__touchResumeAttempts)).toBe(2);
  } finally {
    await context.close();
  }
});
