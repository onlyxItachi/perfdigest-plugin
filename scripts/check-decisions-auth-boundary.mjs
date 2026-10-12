// Separate opt-in diagnostic; never reads a real credential or sends project evidence.
import { authenticationBoundarySmoke, decisionsFailure } from '../dist/decisions.js';
try {
  console.log(JSON.stringify({ scope: 'authentication boundary only', ...await authenticationBoundarySmoke() }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', scope: 'authentication boundary only',
    liveInferenceValidated: false, error: decisionsFailure(error).toJSON() }, null, 2));
  process.exitCode = 1;
}
