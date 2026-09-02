import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
// Canvas stub: jsdom has no 2D context. Kept in sync with what the strip and the
// legend's error swatch actually call (the error marker adds path/stroke calls).
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: vi.fn(() => ({ scale: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), roundRect: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })), fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt", globalAlpha: 1 })) });
// jsdom has no ResizeObserver; EventLanes (and the virtual list) observe their
// scroller with it. A never-firing stub is the honest stand-in for layout that
// does not happen in jsdom.
Object.defineProperty(window, "ResizeObserver", { value: vi.fn(function (this: { observe: unknown; unobserve: unknown; disconnect: unknown }) { this.observe = vi.fn(); this.unobserve = vi.fn(); this.disconnect = vi.fn(); }) });
Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { value: vi.fn() });
Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { value: vi.fn() });
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", { value: () => ({ width: 800, height: 32, top: 0, left: 0, right: 800, bottom: 32, x: 0, y: 0, toJSON: () => ({}) }) });
Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: vi.fn() });
Object.defineProperty(window, "matchMedia", { value: vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
