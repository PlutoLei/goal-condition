import {
  contractHash, readContract, renderContractDiagnostic, renderPreview, validateContract,
} from './lib/contract.mjs';

const args = process.argv.slice(2);
const preview = args.length === 3 && args[0] === '--contract' && args[2] === '--preview';
const validateOnly = args.length === 2 && args[0] === '--contract';

if (!preview && !validateOnly) {
  console.error('Usage: node scripts/validate-contract.mjs --contract FILE [--preview]');
  process.exitCode = 2;
} else {
  try {
    const contract = await readContract(args[1]);
    const diagnostics = validateContract(contract);
    if (diagnostics.length > 0) {
      for (const item of diagnostics) {
        console.error(renderContractDiagnostic(item));
      }
      process.exitCode = 1;
    } else {
      console.log(`VALID contract sha256=${contractHash(contract)}`);
      if (preview) console.log(renderPreview(contract));
    }
  } catch (error) {
    if (error?.code !== undefined && error?.path !== undefined
      && error?.expected !== undefined && error?.next !== undefined) {
      console.error(renderContractDiagnostic(error));
    } else {
      console.error('CONTRACT_READ_FAILED contract observed="type=read_failure" expected="readable canonical JSON contract" next="supply a readable canonical JSON file"');
    }
    process.exitCode = 1;
  }
}
