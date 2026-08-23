import { test, expect } from '@playwright/test';

/**
 * SYSTEM — the Foundation page in a real browser, desktop and 375px.
 *
 * TIER JUSTIFICATION, and it is specific here. The section this page was
 * rewritten from arrived as raw HTML carrying another component's Astro scope
 * hash (data-astro-cid-j7pv25f6) and class names — .section__title,
 * .section__lede, .stats, .cta — that are scoped to components it was never
 * going to be rendered inside. Pasted in as-is it would have produced the
 * correct words, in the correct order, with the correct link targets, and
 * *every one* of the 219 string-level tests in this repo would still have
 * passed — while the block rendered as undifferentiated unstyled text.
 *
 * Only a browser computing styles can tell those two outcomes apart, so the
 * assertions below are about rendering, not content.
 */

const GOLD = 'rgb(184, 137, 60)'; // --c-gold, the ReviewNote's left rule

test.describe('the Foundation page renders as a designed page', () => {
  test('the review note is visibly a review note, not plain text', async ({ page }) => {
    await page.goto('/give/nvvvf');

    const note = page.locator('aside.review');
    await expect(note).toHaveCount(1);
    await expect(note).toBeVisible();

    const style = await note.evaluate((el) => {
      const computed = getComputedStyle(el);
      return {
        borderColor: computed.borderInlineStartColor,
        borderWidth: computed.borderInlineStartWidth,
        background: computed.backgroundColor,
      };
    });

    // If the component's scoped stylesheet had not reached this element, the
    // border would be 0px and the background transparent — which is exactly
    // what pasting foreign markup produces.
    expect(style.borderColor, 'the review note lost its gold rule — is its CSS scoped correctly?').toBe(GOLD);
    expect(style.borderWidth).toBe('3px');
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('the two payee cards sit side by side on desktop and stack on a phone', async ({ page, isMobile }) => {
    await page.goto('/give/nvvvf');

    const cards = page.locator('.payee');
    await expect(cards).toHaveCount(2);

    const boxes = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    if (isMobile) {
      expect(boxes[1], 'the payee cards overlap at 375px').toBeGreaterThan(boxes[0]);
    } else {
      expect(Math.abs(boxes[1] - boxes[0]), 'the payee cards should be a row on desktop').toBeLessThan(4);
    }

    // Two organizations, two addresses. Both must be readable, and scoped to
    // the cards — the chapter's own address is also in the footer of every page,
    // which is exactly the confusion these cards exist to prevent.
    await expect(cards.filter({ hasText: 'PO Box 2111' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'P.O. Box 5653' })).toHaveCount(1);
    await expect(cards.getByText('PO Box 2111')).toBeVisible();
    await expect(cards.getByText('P.O. Box 5653')).toBeVisible();
  });

  test('the supplied graphic loads and is not upscaled', async ({ page }) => {
    await page.goto('/give/nvvvf');
    const img = page.locator('main figure img').first();
    await expect(img).toBeVisible();

    const { natural, rendered, alt } = await img.evaluate((el) => {
      const image = el as HTMLImageElement;
      return { natural: image.naturalWidth, rendered: image.getBoundingClientRect().width, alt: image.alt };
    });

    expect(natural, 'the partnership graphic failed to load').toBeGreaterThan(0);
    expect(rendered, `upscaled: ${rendered}px from ${natural}px`).toBeLessThanOrEqual(natural + 1);
    // The graphic has its headline set into the pixels; WCAG 1.4.5 puts those
    // words in the alt, so a screen reader gets them too.
    expect(alt).toContain('One Mission. Two Organizations. One Commitment to Veterans.');
  });
});

test.describe('the disclosure a donor has to be able to see', () => {
  test('both readings of both contradicted figures are on screen', async ({ page }) => {
    await page.goto('/give/nvvvf');
    const note = page.locator('aside.review');

    // Not "in the DOM" — visible. A disclosure collapsed behind a details
    // element, or clipped to zero height, is not a disclosure.
    await expect(note.getByText('92', { exact: false }).first()).toBeVisible();
    for (const figure of ['84', '$101,598', '$169,000']) {
      await expect(note.getByText(figure, { exact: false }).first()).toBeVisible();
    }
  });

  test('the Foundation website is named but not linked', async ({ page }) => {
    await page.goto('/give/nvvvf');
    await expect(page.getByText('nvvvf.org').first()).toBeVisible();
    await expect(page.locator('main a[href*="nvvvf.org"]')).toHaveCount(0);
  });
});

test.describe('the links leave the page correctly', () => {
  test('the primary call to action stays on this origin', async ({ page, baseURL }) => {
    // The string tiers can only prove an href "looks relative". This proves
    // that clicking it does not leave the site — which is the actual failure
    // the drafted section shipped, as an absolute staging URL that resolves.
    await page.goto('/give/nvvvf');

    const cta = page.locator('aside.cta a.btn--solid');
    await expect(cta).toBeVisible();

    const box = await cta.boundingBox();
    expect(box!.height, 'the call to action is below a comfortable tap target').toBeGreaterThanOrEqual(40);

    await cta.click();
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    await expect(page).toHaveURL(/\/give$/);
  });

  test('the page a veteran might need is one tap away', async ({ page }) => {
    // This page is written for donors. The one paragraph on it addressed to a
    // veteran must not be decoration.
    await page.goto('/give/nvvvf');
    const callout = page.locator('.callout');
    await expect(callout).toBeVisible();
    await callout.getByRole('link', { name: 'Get Help' }).click();
    await expect(page).toHaveURL(/\/get-help$/);
    await expect(page.locator('h1')).toContainText('Get Help');
  });

  test('it is reachable from the site navigation, not only by its URL', async ({ page, isMobile }) => {
    await page.goto('/give');
    if (isMobile) {
      await page.locator('details.menu summary').click();
    }
    const link = page.locator(`${isMobile ? '.menu__panel' : 'footer'} a[href="/give/nvvvf"]`).first();
    await expect(link).toBeVisible();
  });

  test('and from the body of the page a donor is actually reading', async ({ page }) => {
    // The footer links every nav route on every page, so the assertion above is
    // satisfied by site furniture. This one is not.
    await page.goto('/give');
    const inBody = page.locator('main a[href="/give/nvvvf"]');
    await expect(inBody).toHaveCount(1);
    await inBody.click();
    await expect(page).toHaveURL(/\/give\/nvvvf$/);
    await expect(page.locator('h1')).toContainText('Northern Virginia Vietnam Veterans Foundation');
  });
});
