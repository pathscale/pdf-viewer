import { createRequire } from "node:module";
import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import { pluginSolidLayoutsApplication } from "rsbuild-plugin-solid-layouts";
import packageInfo from "./package.json";

const localRequire = createRequire(import.meta.url);

export default defineConfig(({ command }) => {
  const building = command === "build";

  return {
    source: {
      // The entry is named index so the page is index.html; the bundle keeps the
      // fixed app.js / app.css names the Rust side embeds.
      entry: { index: "./src/index.tsx" },
    },
    plugins: [
      pluginSolidLayoutsApplication({
        layouts: ["@pathscale/ui"],
      }),
      pluginBabel({
        include: /\.(?:jsx|tsx|ts)$/,
        babelLoaderOptions: (config) => {
          config.presets ??= [];
          config.presets.push(localRequire.resolve("babel-preset-solid"));
        },
      }),
    ],
    resolve: {
      alias: {
        "solid-layouts/application-boundary$": "solid-layouts/solid-2/application-boundary",
        "solid-layouts$": "solid-layouts/solid-2",
        "solid-layouts/recipe$": "solid-layouts/solid-2/recipe",
        "solid-layouts/cx$": "solid-layouts/solid-2/cx",
        "tailwind-merge$": "./node_modules/tailwind-merge/dist/bundle-mjs.mjs",
        "~": "./src",
      },
    },
    html: {
      title: "PDF Viewer",
      mountId: "root",
      inject: building ? false : "body",
      meta: {
        viewport: "width=device-width, initial-scale=1",
        "color-scheme": "light dark",
      },
      tags: building
        ? [
            {
              tag: "link",
              attrs: { rel: "stylesheet", href: "./app.css" },
              head: true,
            },
            {
              tag: "script",
              attrs: { src: `./app.js?v=${packageInfo.version}`, defer: true },
              head: false,
            },
          ]
        : [],
    },
    dev: {
      hmr: true,
      liveReload: true,
    },
    server: {
      port: 3013,
    },
    tools: {
      rspack(config, { appendPlugins }) {
        if (config.resolve) delete config.resolve.tsConfig;
        config.optimization ??= {};
        config.optimization.splitChunks = false;
        config.optimization.runtimeChunk = false;
        appendPlugins(
          new ForkTsCheckerWebpackPlugin({
            typescript: { configFile: "./tsconfig.json" },
          }),
        );
      },
    },
    output: {
      distPath: { root: "dist", js: "", css: "" },
      filename: { js: "app.js", css: "app.css" },
      filenameHash: false,
      cleanDistPath: true,
      assetPrefix: "./",
      inlineStyles: false,
      legalComments: "none",
      dataUriLimit: {
        font: 1024 * 1024,
      },
    },
  };
});

