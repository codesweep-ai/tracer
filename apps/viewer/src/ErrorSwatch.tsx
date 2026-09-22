/** The key for a failed step, as the strip draws one (R47): a cell in the error
 *  colour. The legend and the errors-only control both show it. */
export function ErrorSwatch() {
  return <span aria-hidden="true" className="error-swatch" />;
}
