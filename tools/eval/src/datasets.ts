import { resolve } from "node:path";

export const DATASETS = {
  v2: {
    id: "v2",
    label: "V2 official benchmark",
    root: resolve("training_data/sdoc-hackathon-docker/extracted/data_v2"),
  },
  v3: {
    id: "v3",
    label: "V3 high-difficulty synthetic",
    root: resolve("data_v3"),
    exclusions: resolve("data_v3/exclusions.json"),
  },
  v4: {
    id: "v4",
    label: "V4 adversarial robustness",
    root: resolve("data_v4"),
    allDocuments: true,
  },
  v5: {
    id: "v5",
    label: "V5 real-world scenarios",
    root: resolve("data_v5"),
  },
} as const;

export type DatasetId = keyof typeof DATASETS;

export function datasetConfig(id: string) {
  if (!(id in DATASETS)) throw new Error(`Unknown dataset ${id}. Choose ${Object.keys(DATASETS).join(", ")}.`);
  return DATASETS[id as DatasetId];
}
