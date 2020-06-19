const { deployContract, deployMockContract } = require('ethereum-waffle')
const { deploy1820 } = require('deploy-eip-1820')
const MockGovernor = require('../build/MockGovernor.json')
const RNGServiceMock = require('../build/RNGServiceMock.json')
const MockPrizeStrategy = require('../build/MockPrizeStrategy.json')
const CompoundPeriodicPrizePoolHarness = require('../build/CompoundPeriodicPrizePoolHarness.json')
const Ticket = require('../build/Ticket.json')
const ControlledToken = require('../build/ControlledToken.json')
const CTokenInterface = require('../build/CTokenInterface.json')

const { ethers } = require('./helpers/ethers')
const { expect } = require('chai')
const buidler = require('./helpers/buidler')
const getIterable = require('./helpers/iterable')

const toWei = ethers.utils.parseEther
const toBytes = ethers.utils.toUtf8Bytes
const EMPTY_STR = toBytes('')

const debug = require('debug')('ptv3:PeriodicPrizePool.test')

const FORWARDER = '0x5f48a3371df0F8077EC741Cc2eB31c84a4Ce332a'

let overrides = { gasLimit: 20000000 }


describe.only('PeriodicPrizePool contract', function() {
  let wallet, wallet2

  let registry, governor, rngService, prizePool, prizeStrategy, cToken

  let ticket, ticketCredit, sponsorship, sponsorshipCredit

  let prizePeriodSeconds = toWei('1000')

  beforeEach(async () => {
    [wallet, wallet2] = await buidler.ethers.getSigners()

    debug(`using wallet ${wallet._address}`)

    debug('deploying registry...')
    registry = await deploy1820(wallet)

    debug('deploying protocol governor...')
    governor = await deployContract(wallet, MockGovernor, [], overrides)

    debug('deploying rng service...')
    rngService = await deployContract(wallet, RNGServiceMock, [], overrides)

    debug('deploying prize strategy...')
    prizeStrategy = await deployContract(wallet, MockPrizeStrategy, [], overrides)
  
    debug('mocking tokens...')
    cToken = await deployMockContract(wallet, CTokenInterface.abi, overrides)
    ticket = await deployMockContract(wallet, Ticket.abi, overrides)
    ticketCredit = await deployMockContract(wallet, ControlledToken.abi, overrides)
    sponsorship = await deployMockContract(wallet, ControlledToken.abi, overrides)
    sponsorshipCredit = await deployMockContract(wallet, ControlledToken.abi, overrides)

    // Common Mocks for Tokens
    await cToken.mock.underlying.returns(cToken.address)

    debug('deploying prizePool...')
    prizePool = await deployContract(wallet, CompoundPeriodicPrizePoolHarness, [], overrides)

    debug('initializing prizePool...')
    await prizePool.initialize(
      FORWARDER,
      governor.address,
      prizeStrategy.address,
      rngService.address,
      prizePeriodSeconds,
      cToken.address
    )
    debug('setting prizePool tokens...')
    await prizePool.setTokens(
      ticket.address,
      sponsorship.address,
      ticketCredit.address,
      sponsorshipCredit.address
    )
  })

  describe('initialize()', () => {
    it('should set the params', async () => {
      expect(await prizePool.getTrustedForwarder()).to.equal(FORWARDER)
      expect(await prizePool.governor()).to.equal(governor.address)
      expect(await prizePool.prizeStrategy()).to.equal(prizeStrategy.address)
      expect(await prizePool.rng()).to.equal(rngService.address)
      expect(await prizePool.prizePeriodSeconds()).to.equal(prizePeriodSeconds)
      expect(await prizePool.cToken()).to.equal(cToken.address)
    })
  })

  describe('setTokens()', () => {
    it('should set the token addresses', async () => {
      expect(await prizePool.ticket()).to.equal(ticket.address)
      expect(await prizePool.sponsorship()).to.equal(sponsorship.address)
      expect(await prizePool.ticketCredit()).to.equal(ticketCredit.address)
      expect(await prizePool.sponsorshipCredit()).to.equal(sponsorshipCredit.address)
    })

    it('should not allow setting the token addresses twice', async () => {
      await expect(prizePool.setTokens(ticket.address, sponsorship.address, ticketCredit.address, sponsorshipCredit.address))
        .to.be.revertedWith('already initialized')
    })
  })

  describe('supplySponsorship()', () => {
    it('should mint sponsorship tokens', async () => {
      const supplyAmount = toWei('10')

      await cToken.mock.transferFrom.withArgs(wallet._address, prizePool.address, supplyAmount).returns(true)
      await cToken.mock.balanceOfUnderlying.withArgs(prizePool.address).returns(supplyAmount)
      await sponsorship.mock.controllerMint.withArgs(wallet._address, supplyAmount, EMPTY_STR, EMPTY_STR).returns()
      await sponsorship.mock.balanceOf.withArgs(wallet._address).returns(supplyAmount)
      await sponsorshipCredit.mock.controllerMint.withArgs(wallet._address, toWei('0'), EMPTY_STR, EMPTY_STR).returns()

      // Supply sponsorship
      await expect(prizePool.supplySponsorship(wallet._address, supplyAmount, EMPTY_STR, EMPTY_STR))
        .to.emit(prizePool, 'SponsorshipSupplied')
        .withArgs(wallet._address, wallet._address, supplyAmount)
        .to.emit(prizePool, 'SponsorshipInterestMinted')
        .withArgs(wallet._address, wallet._address, supplyAmount)

      expect(await prizePool.balanceOfSponsorshipInterestShares(wallet._address)).to.equal(supplyAmount)
    })
  })

  describe('redeemSponsorship()', () => {
    it('should allow a sponsor to redeem their sponsorship tokens', async () => {
      const amount = toWei('10')
      const interestAmount = toWei('1')

      // Pre-fund Prize-Pool
      await prizePool.supplyCollateralForTest(amount)
      await prizePool.setSponsorshipInterestSharesForTest(wallet._address, amount)

      await cToken.mock.balanceOfUnderlying.withArgs(prizePool.address).returns(toWei('0'))
      await sponsorship.mock.balanceOf.withArgs(wallet._address).returns(amount)

      await cToken.mock.redeemUnderlying.withArgs(amount).returns(amount)
      await cToken.mock.transfer.withArgs(wallet._address, amount).returns(true)

      await sponsorship.mock.controllerBurn.withArgs(wallet._address, amount, EMPTY_STR, EMPTY_STR).returns()
      await sponsorshipCredit.mock.controllerMint.withArgs(wallet._address, toWei('0'), EMPTY_STR, EMPTY_STR).returns()

      // Test redeemSponsorship
      await expect(prizePool.redeemSponsorship(amount, EMPTY_STR, EMPTY_STR))
        .to.emit(prizePool, 'SponsorshipRedeemed')
        .withArgs(wallet._address, wallet._address, amount)
    })

    it('should not allow a sponsor to redeem more sponsorship tokens than they hold', async () => {
      const amount = toWei('10')

      // Pre-fund Prize-Pool
      await prizePool.supplyCollateralForTest(amount)
      await prizePool.setSponsorshipInterestSharesForTest(wallet._address, amount)

      // Test revert
      await expect(prizePool.redeemSponsorship(amount.mul(2), EMPTY_STR, EMPTY_STR))
        .to.be.revertedWith('Insufficient balance')
    })
  })

  describe('operatorRedeemSponsorship()', () => {
    it('should allow an operator to redeem on behalf of a sponsor their sponsorship tokens', async () => {
      const amount = toWei('10')
      const interestAmount = toWei('1')

      // Pre-fund Prize-Pool
      await prizePool.supplyCollateralForTest(amount)
      await prizePool.setSponsorshipInterestSharesForTest(wallet._address, amount)

      await cToken.mock.balanceOfUnderlying.returns(toWei('0'))
      await sponsorship.mock.balanceOf.withArgs(wallet._address).returns(amount)

      await cToken.mock.redeemUnderlying.withArgs(amount).returns(amount)
      await cToken.mock.transfer.withArgs(wallet._address, amount).returns(true)

      await sponsorship.mock.controllerBurn.withArgs(wallet._address, amount, EMPTY_STR, EMPTY_STR).returns()
      await sponsorshipCredit.mock.controllerMint.withArgs(wallet._address, toWei('0'), EMPTY_STR, EMPTY_STR).returns()

      // approved operator
      await sponsorship.mock.isOperatorFor.withArgs(wallet2._address, wallet._address).returns(true)

      // Test operator redeem
      await expect(prizePool.connect(wallet2).operatorRedeemSponsorship(wallet._address, amount, EMPTY_STR, EMPTY_STR))
        .to.emit(prizePool, 'SponsorshipRedeemed')
        .withArgs(wallet2._address, wallet._address, amount)
    })

    it('should not allow an unapproved operator to redeem on behalf of a sponsor', async () => {
      const amount = toWei('10')

      // Pre-fund Prize-Pool
      await prizePool.supplyCollateralForTest(amount)
      await prizePool.setSponsorshipInterestSharesForTest(wallet._address, amount)

      // unapproved operator
      await sponsorship.mock.isOperatorFor.withArgs(wallet2._address, wallet._address).returns(false)

      // Test redeem revert
      await expect(prizePool.connect(wallet2).operatorRedeemSponsorship(wallet._address, amount, EMPTY_STR, EMPTY_STR))
        .to.be.revertedWith('Invalid operator');
    })
  })

  describe('sweepSponsorship()', () => {
    it('should allow anyone to sweep sponsorship for a list of users', async () => {
      const amounts = [toWei('10'), toWei('98765'), toWei('100'), toWei('100000000'), toWei('10101101')]
      const iterableAccounts = getIterable(await buidler.ethers.getSigners(), amounts.length)
      const accountAddresses = []
      const interestAmount = toWei('1')
      let totalSupply = toWei('0')

      // TotalSupply = 0
      await cToken.mock.balanceOfUnderlying.returns(totalSupply)

      // Pre-fund sponsorship tokens *with interest*
      for await (let user of iterableAccounts()) {
        await prizePool.supplyCollateralForTest(amounts[user.index])
        await prizePool.setSponsorshipInterestSharesForTest(user.data._address, amounts[user.index].add(interestAmount)) // + interest

        accountAddresses.push(user.data._address)
        totalSupply = totalSupply.add(amounts[user.index])
      }

      // TotalSupply = Sum of all Balances
      await cToken.mock.balanceOfUnderlying.returns(totalSupply)

      // Mocks for multiple accounts
      for await (let user of iterableAccounts()) {
        const amount = amounts[user.index]
        await cToken.mock.redeemUnderlying.withArgs(amount).returns(amount)
        await cToken.mock.transfer.withArgs(user.data._address, amount).returns(true)
        await sponsorship.mock.balanceOf.withArgs(user.data._address).returns(amount)

        await sponsorship.mock.controllerBurn.withArgs(user.data._address, amount, EMPTY_STR, EMPTY_STR).returns()
        await sponsorshipCredit.mock.controllerMint.withArgs(user.data._address, interestAmount, EMPTY_STR, EMPTY_STR).returns()
      }

      // Sweep for multiple accounts
      await expect(prizePool.sweepSponsorship(accountAddresses, EMPTY_STR, EMPTY_STR))
        .to.emit(prizePool, 'SponsorshipInterestBurned')
        .withArgs(wallet._address, accountAddresses[0], interestAmount)

      // Test balances; all interest swept
      for await (let user of iterableAccounts()) {
        expect(await prizePool.balanceOfSponsorshipInterestShares(user.data._address)).to.equal(amounts[user.index]) // "interestAmount" swept
      }
    })
  })

});



