import { test, expect, type Page } from '@playwright/test';

/**
 * SYSTEM — the real browser, the real rendered page.
 *
 * TIER JUSTIFICATION: every tier below this reads HTML as a string. None of
 * them can see a layout that overflows the viewport, a sticky header that
 * covers the content it anchors to, a disclosure menu that never opens, or an
 * image that 404s at request time. Those are precisely the failures the legacy
 * site shipped, so they get tested where they actually occur.
 */

const ROUTES = [
  '/',
  '/get-help',
  '/get-help/vet-center',
  '/get-help/treatment-court',
  '/join',
  '/join/avva',
  '/give',
  '/give/impact',
  '/give/nvvvf',
  '/programs',
  '/events',
  '/events/news',
  '/about',
  '/about/dean-k-phillips',
  '/about/leadership',
  '/about/reports',
  '/about/reports/2024',
  '/contact',
  '/privacy',
];

/** Collect console errors, page errors and failed requests for a navigation. */
function watchForErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('requestfailed', (req) => {
    errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText})`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) errors.push(`http ${res.status()}: ${res.url()}`);
  });
  return errors;
}

test.describe('every page loads cleanly', () => {
  for (const route of ROUTES) {
    test(`${route} renders with no errors and no horizontal scroll`, async ({ page }) => {
      const errors = watchForErrors(page);

      const response = await page.goto(route);
      expect(response?.status(), `${route} did not return 200`).toBe(200);

      // Exactly one h1, and it is not empty.
      const h1 = page.locator('h1');
      await expect(h1).toHaveCount(1);
      await expect(h1).not.toBeEmpty();

      // The crisis line is on every page, above everything else. Scoped to the
      // banner because /get-help legitimately repeats the instruction in prose.
      await expect(page.locator('aside.crisis').getByText('Dial 988, then press 1')).toBeVisible();

      // The body must never scroll sideways at any viewport.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${route} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);

      expect(errors, `${route} produced errors:\n${errors.join('\n')}`).toEqual([]);
    });
  }
});

test.describe('navigation', () => {
  test('the primary journeys are reachable from the home page', async ({ page, isMobile }) => {
    await page.goto('/');

    if (isMobile) {
      // The header collapses to a native <details> disclosure below 68rem.
      const menu = page.locator('details.menu');
      await expect(menu).toBeVisible();
      await expect(page.locator('.menu__panel')).toBeHidden();
      await menu.locator('summary').click();
      await expect(page.locator('.menu__panel')).toBeVisible();
      await page.locator('.menu__panel a[href="/get-help"]').click();
    } else {
      await page.locator('nav[aria-label="Main"] a[href="/get-help"]').click();
    }

    await expect(page).toHaveURL(/\/get-help$/);
    await expect(page.locator('h1')).toContainText('Get Help');
  });

  test('the Donate call to action is always reachable in the header', async ({ page }) => {
    await page.goto('/');
    const cta = page.locator('header a.give-cta');
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page).toHaveURL(/\/give$/);
  });

  test('the current section is marked for assistive technology', async ({ page }) => {
    await page.goto('/join');
    await expect(page.locator('a[href="/join"][aria-current="page"]').first()).toHaveCount(1);
  });

  test('the sticky header stays a reasonable share of the viewport', async ({ page }) => {
    // Regression guard: the full chapter name wrapped to four lines at 390px,
    // making the header ~460px tall on an 844px screen. A sticky header that
    // large covers the content it is supposed to sit above.
    await page.goto('/');
    const header = page.locator('header.header');
    const box = await header.boundingBox();
    const viewport = page.viewportSize();

    expect(box, 'header has no bounding box').not.toBeNull();
    expect(viewport, 'no viewport size').not.toBeNull();

    const share = box!.height / viewport!.height;
    expect(
      share,
      `header is ${Math.round(box!.height)}px of a ${viewport!.height}px viewport (${Math.round(share * 100)}%)`,
    ).toBeLessThan(0.2);
  });

  test('the header shows exactly one chapter name to assistive technology', async ({ page }) => {
    // The compact and full lockups must never both be reachable — that would
    // make the link announce the chapter name twice.
    await page.goto('/');
    const brand = page.locator('a.brand');
    const name = (await brand.innerText()).replace(/\s+/g, ' ').trim();
    expect(name).not.toMatch(/Vietnam Veterans of America.*VVA Chapter 227/i);
    expect(name.length, 'brand link has no accessible text').toBeGreaterThan(5);
  });

  test('the skip link takes keyboard users to main content', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('href', '#main');
    await expect(focused).toBeVisible();
  });
});

test.describe('the facts a visitor actually came for', () => {
  test('the meeting day, time and address are on the events page', async ({ page }) => {
    await page.goto('/events');
    const body = page.locator('main');
    await expect(body).toContainText('Third Thursday');
    await expect(body).toContainText('American Legion Post 177');
    await expect(body).toContainText('3939 Oak Street');
    await expect(body).toContainText('7:00 pm');

    // The directions link must be a real link — on the legacy site "Click for
    // Directions with Google Maps" was plain text.
    const directions = page.getByRole('link', { name: 'Get directions' }).first();
    await expect(directions).toHaveAttribute('href', /google\.com\/maps/);
  });

  test('the home page states what the chapter paid out', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main')).toContainText('$39,700');
    await expect(page.locator('main')).toContainText('418');
  });

  test('the membership application PDF downloads', async ({ page, request }) => {
    await page.goto('/join');
    const link = page.getByRole('link', { name: /membership application/i });
    await expect(link).toBeVisible();

    const href = await link.getAttribute('href');
    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('pdf');
  });

  test('the newsletter archive lists issues by human date, not filename', async ({ page }) => {
    await page.goto('/events/news');
    await expect(page.locator('main')).toContainText('November 2024');
    // The legacy archive showed raw filenames in a <select>.
    await expect(page.locator('main')).not.toContainText('The_Journey_202411.pdf');
    await expect(page.locator('main select')).toHaveCount(0);
  });
});

test.describe('images', () => {
  test('every image on the home page actually loads and is not upscaled', async ({ page }) => {
    await page.goto('/');

    // Card images use loading="lazy", so naturalWidth stays 0 until they enter
    // the viewport. Scroll the whole page, then wait for every image to settle.
    await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 400));
      window.scrollTo(0, 0);
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('main img')].every((img) => (img as HTMLImageElement).complete),
    );

    const images = page.locator('main img');
    const count = await images.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const img = images.nth(i);
      const { natural, rendered, alt, src } = await img.evaluate((el) => {
        const image = el as HTMLImageElement;
        return {
          natural: image.naturalWidth,
          rendered: image.getBoundingClientRect().width,
          alt: image.alt,
          src: image.currentSrc || image.src,
        };
      });

      expect(natural, `${src} failed to load`).toBeGreaterThan(0);
      expect(alt.length, `${src} has no alt text`).toBeGreaterThan(20);
      // The chapter's photographs are 650-800px wide. Rendering one wider than
      // its natural size is what made the legacy banners look soft.
      expect(rendered, `${src} is upscaled (${rendered}px from ${natural}px)`).toBeLessThanOrEqual(natural + 1);
    }
  });
});

test.describe('the 404 page', () => {
  test('offers real routes rather than a dead end', async ({ page }) => {
    await page.goto('/404');
    await expect(page.locator('h1')).toContainText('could not find');
    // Scoped to main — the footer links to the same destinations on every page.
    const routes = page.locator('main ul.routes');
    await expect(routes.getByRole('link', { name: 'Get help' })).toBeVisible();
    await expect(routes.getByRole('link', { name: 'Ways to give' })).toBeVisible();
  });
});
