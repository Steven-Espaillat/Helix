import { expect, type Page } from "@playwright/test";

// DH-2 (#66): the legacy StudyJourney is off the default stage path. Specs that exercise the
// legacy component itself (its records and its still-wired controls) open it explicitly.

export const legacyJourney = (page: Page) => page.locator("#journey-heading");

export async function openLegacyJourney(page: Page) {
  const toggle = page.getByTestId("legacy-journey-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(legacyJourney(page)).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(legacyJourney(page)).toBeVisible();
}
