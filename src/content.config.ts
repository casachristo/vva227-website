import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Content collections.
 *
 * The schemas are the contract between the people who edit copy and the
 * components that render it. A missing or mistyped field fails the BUILD rather
 * than rendering an empty page — which is exactly the failure mode the legacy
 * site shipped four times over, in pages titled "Christmas Party", "Vehicles",
 * "Clothing and Furniture" and "More Details Coming" that contained nothing but
 * their own headings.
 */

const reports = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/reports' }),
  schema: z.object({
    /** Calendar year the letter reports on. Drives the URL and the ordering. */
    year: z.number().int().min(1985).max(2100),
    /** The president's own headline, kept verbatim. */
    title: z.string().min(1),
    /** Some early letters carry no byline. Null is honest; "Unknown" is not. */
    author: z.string().nullable(),
    summary: z.string().min(1).max(400),
  }),
});

export const collections = { reports };
