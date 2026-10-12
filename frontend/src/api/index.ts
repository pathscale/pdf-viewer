import type { ViewerApi } from "./client";
import { createIzumoApi } from "./izumo";
import { createMockApi } from "./mock";

export type * from "./client";

export const isMock = !("__IZUMO__" in window);
export const api: ViewerApi = isMock ? createMockApi() : createIzumoApi();
