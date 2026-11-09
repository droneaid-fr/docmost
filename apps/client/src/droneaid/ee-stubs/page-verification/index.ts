// Core expects: PageVerificationBadge({ readOnly }), PageVerificationMenuItem({ pageId, onClick }), PageVerificationModal({ pageId, opened, onClose }); all render nothing.
export {
  RenderNothing as PageVerificationBadge,
  RenderNothing as PageVerificationMenuItem,
  RenderNothing as PageVerificationModal,
} from "../_lib/render-nothing";
