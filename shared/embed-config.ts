// ABOUTME: Defines the visibility rule shared by all public embed renderers.
// ABOUTME: Omitted settings preserve the complete fields shown by existing embeds.
import type { EmbedConfig } from "./api.ts";

export type EmbedVisibilityField = keyof {
  [Field in keyof EmbedConfig as Field extends `show${string}` ? Field : never]: true;
};

export function embedFieldIsVisible(config: EmbedConfig, field: EmbedVisibilityField): boolean {
  return config[field] !== false;
}
