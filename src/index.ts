import {
  Action,
  ActionError,
  ActionGetResponse,
  ActionPostRequest,
  ActionPostResponse,
  LinkedAction,
} from '@solana/actions';
import axios from 'axios';
import * as bitcoin from 'bitcoinjs-lib';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const DONATION_AMOUNT_BTC_OPTIONS = [1, 5, 10];
const DEFAULT_DONATION_AMOUNT_BTC = 1;
const SATOSHI_PER_BTC = 100000000;
const esploraApiUrl: Record<string, string> = {
  testnet: 'https://blockstream.info/testnet/api',
  mainnet: 'https://blockstream.info/api',
};

const app = new Hono();

app.use(
  '/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Content-Encoding',
      'Authorization',
      'Accept-Encoding',
    ],
  }),
  async (c, next) => {
    await next();
    c.res.headers.set('X-Action-Version', '2.4');
    const network = c.req.param('network');
    if (network === 'mainnet') {
      c.res.headers.set(
        'X-Blockchain-Ids',
        'bip122:000000000019d6689c085ae165831e93',
      );
    }
    if (network === 'testnet') {
      c.res.headers.set(
        'X-Blockchain-Ids',
        'bip122:000000000933ea01ad0ee984209779ba',
      );
    }
  },
);

app.get('/:network/donate/:recipient', (c) => {
  const { icon, title, description } = getDonateInfo();
  const amountParameterName = 'amount';
  const network = c.req.param('network');
  const recipient = c.req.param('recipient');
  const response: Action = {
    type: 'action',
    icon,
    label: `${DEFAULT_DONATION_AMOUNT_BTC} BTC`,
    title,
    description,
    links: {
      actions: [
        ...DONATION_AMOUNT_BTC_OPTIONS.map(
          (amount) =>
            ({
              type: 'transaction',
              label: `${amount} BTC`,
              href: `/${network}/donate/${recipient}/${amount}`,
            }) satisfies LinkedAction,
        ),
        {
          type: 'transaction',
          href: `/${network}/donate/${recipient}/{${amountParameterName}}`,
          label: 'Donate',
          parameters: [
            {
              name: amountParameterName,
              label: 'Enter a custom BTC amount',
            },
          ],
        } satisfies LinkedAction,
      ],
    },
  };

  return c.json(response, 200);
});

app.get('/:network/donate/:recipient/:amount', (c) => {
  const amount = c.req.param('amount');
  const { icon, title, description } = getDonateInfo();
  const response: Action = {
    type: 'action',
    icon,
    label: `${amount} BTC`,
    title,
    description,
  };
  return c.json(response, 200);
});

app.post('/:network/donate/:recipient/:amount?', async (c) => {
  const amount =
    c.req.param('amount') ?? DEFAULT_DONATION_AMOUNT_BTC.toString();
  const network = c.req.param('network');
  const recipient = c.req.param('recipient');
  const { account } = (await c.req.json()) as ActionPostRequest;

  const parsedAmount = parseFloat(amount);
  try {
    const transaction = await prepareDonateTransaction(
      network,
      account,
      recipient,
      parsedAmount * SATOSHI_PER_BTC,
    );
    const response: ActionPostResponse = {
      type: 'transaction',
      transaction: transaction,
    };
    return c.json(response, 200);
  } catch (e) {
    return Response.json(
      {
        message: `${getErrorMessage(e)}`,
      } satisfies ActionError,
      {
        status: 400,
      },
    );
  }
});

function getDonateInfo(): Pick<
  ActionGetResponse,
  'icon' | 'title' | 'description'
> {
  const icon =
    'https://ucarecdn.com/7aa46c85-08a4-4bc7-9376-88ec48bb1f43/-/preview/880x864/-/quality/smart/-/format/auto/';
  const title = 'Donate to Alice';
  const description =
    'Cybersecurity Enthusiast | Support my research with a donation.';
  return { icon, title, description };
}

async function prepareDonateTransaction(
  network: string,
  sender: string,
  recipient: string,
  satoshi: number,
): Promise<string> {
  const utxos = await getUTXOs(network, sender);
  if (!utxos || utxos.length === 0) {
    throw new Error('Insufficient funds');
  }
  const psbt = new bitcoin.Psbt({
    network:
      network == 'mainnet'
        ? bitcoin.networks.bitcoin
        : bitcoin.networks.testnet,
  });

  let totalInputValue = 0;

  for (const utxo of utxos) {
    const arrayBuffer = await axios.get(
      `${esploraApiUrl[network]}/tx/${utxo.txid}/hex`,
    );
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      nonWitnessUtxo: Buffer.from(arrayBuffer.data, 'hex'),
    });
    totalInputValue += utxo.value;
  }

  if (totalInputValue < satoshi) {
    throw new Error('Insufficient funds');
  }

  psbt.addOutput({
    address: recipient,
    value: satoshi,
  });

  // Сalculate fee
  const recommendedFeeRate = await getRecommendedFeeRate(network);
  const transactionSize = psbt.inputCount * 180 + 2 * 34 + 10 - psbt.inputCount;
  let fee = Math.round(transactionSize * recommendedFeeRate);

  // Change
  if (totalInputValue - satoshi - fee > 0) {
    psbt.addOutput({
      address: sender,
      value: totalInputValue - satoshi - fee,
    });
  }

  return psbt.toBase64();
}

async function getUTXOs(network: string, address: string) {
  try {
    const response = await axios.get(
      `${esploraApiUrl[network]}/address/${address}/utxo`,
    );
    return response.data;
  } catch (error) {
    throw new Error(`Error while getting UTXO: ${error}`);
  }
}

async function getRecommendedFeeRate(network: string): Promise<number> {
  try {
    const response = await axios.get(`${esploraApiUrl[network]}/fee-estimates`);
    const fastFee = response.data['1']; // Fast confirmation (1 block)
    return fastFee;
  } catch (error) {
    console.error('Error while getting recommended fee rate', error);
    return 50; // Standard average fee
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default app;
