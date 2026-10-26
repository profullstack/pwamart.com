import { db } from '@pwamart/db';
import { COLUMNS, createProfileStore, PROFILE_ENHANCE_SCRIPT, renderProfileFields } from '@profullstack/profile';

/**
 * The shared Profullstack profile (@profullstack/profile): email, names, company
 * domain, job title and LinkedIn, in user_profiles (migration 0015). Not the
 * publisher "Fill from website" helper in profile.js.
 *
 * The store is made on first use because the database is (unit tests import the
 * app without one).
 */
let store = null;
export const profiles = new Proxy({}, { get: (_, k) => (store ??= createProfileStore(db()))[k] });

/**
 * The five fields besides email, rendered once by the package and shipped in the
 * console shell as a <template>: the SPA's sign-up form and the contact panel clone
 * it, so the markup, names and autocomplete tokens are the package's own. The
 * console's form already has its own email box.
 */
export const PROFILE_FIELDS = COLUMNS.filter((f) => f !== 'email');
export const profileTemplate = () =>
  `<template id="profile-fields">${renderProfileFields({ fields: PROFILE_FIELDS })}</template>`;

/** Company-from-work-email helper, served as a file (/assets/profile.js). */
export { PROFILE_ENHANCE_SCRIPT };
