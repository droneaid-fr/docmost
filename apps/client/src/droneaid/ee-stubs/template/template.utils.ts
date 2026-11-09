// Core expects: applyTemplateToPage(editor, titleEditor, template) -> applied?; never applies.
import type { ITemplate } from "./types/template.types";

export function applyTemplateToPage(_editor: unknown, _titleEditor: unknown, _template: ITemplate): boolean {
  return false;
}
