// Core expects: getTemplateById(id) -> ITemplate; there are no templates here, so it rejects.
import type { ITemplate } from "../types/template.types";
import { unavailable } from "../../_lib/render-nothing";

export function getTemplateById(_id: string): Promise<ITemplate> {
  return unavailable();
}
