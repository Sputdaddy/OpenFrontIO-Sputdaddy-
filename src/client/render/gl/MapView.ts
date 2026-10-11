import type { MapRenderer } from "./MapRenderer";

/**
 * Everything the client calls on a map renderer: the public surface of
 * MapRenderer. Code that only pushes data into the map takes a MapView, so
 * the WebGL2 renderer and the experimental Three.js one
 * (`../three/ThreeMapRenderer`) are interchangeable.
 */
export type MapView = Pick<MapRenderer, keyof MapRenderer>;
