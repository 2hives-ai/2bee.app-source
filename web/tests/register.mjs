// Installs the resolve hook next to it. Passed with `--import` so it is in
// place before any test module is loaded.
import { register } from 'node:module';

register('./ts-extension-loader.mjs', import.meta.url);
