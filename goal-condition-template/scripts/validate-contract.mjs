import {
  contractHash, readContract, renderPreview, validateContract,
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
        console.error(`${item.code} ${item.path} observed=${JSON.stringify(item.observed)} expected=${JSON.stringify(item.expected)} next=${JSON.stringify(item.next)}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`VALID contract sha256=${contractHash(contract)}`);
      if (preview) console.log(renderPreview(contract));
    }
  } catch (error) {
    if (error?.code && error?.path && error?.expected && error?.next) {
      console.error(`${error.code} ${error.path} observed=${JSON.stringify(error.observed)} expected=${JSON.stringify(error.expected)} next=${JSON.stringify(error.next)}`);
    } else {
      console.error('CONTRACT_READ_FAILED contract observed="type=read_failure" expected="readable canonical JSON contract" next="supply a readable canonical JSON file"');
    }
    process.exitCode = 1;
  }
}
