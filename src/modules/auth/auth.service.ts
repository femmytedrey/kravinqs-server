import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { MailService } from '../mail/mail.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private mail: MailService,
  ) {}

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.email }, { phone: dto.phone }],
      },
    });

    if (exists?.email === dto.email) {
      throw new ConflictException('Email already in use');
    }

    if (exists?.phone === dto.phone) {
      throw new ConflictException('Phone number already in use');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const emailToken = await bcrypt.hash(rawToken, 10);

    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          password: hashedPassword,
          role: dto.role,
        },
      });

      await tx.emailVerificationToken.create({
        data: {
          userId: newUser.id,
          email: newUser.email,
          token: emailToken,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      return newUser;
    });

    const url = `${process.env.CLIENT_URL}/verify-email?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(user.email)}`;

    await this.mail.sendVerificationEmail({
      email: dto.email,
      firstName: dto.firstName,
      url,
    });

    return {
      message: 'Registration successful. Please verify your email.',
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
      },
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const passwordMatch = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatch) throw new UnauthorizedException('Invalid credentials');

    if (!user.isEmailVerified) {
      throw new ForbiddenException(
        'Please verify your email before logging in',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    return {
      message: 'Login successful',
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
      },
      ...tokens,
    };
  }

  async logout(refreshToken: string) {
    const token = await this.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });

    if (!token) throw new BadRequestException('Invalid refresh token');

    await this.prisma.refreshToken.delete({
      where: { token: refreshToken },
    });

    return { message: 'Logged out successfully' };
  }

  async refresh(dto: RefreshTokenDto) {
    const { refreshToken } = dto;
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!storedToken) throw new UnauthorizedException('Invalid refresh token');

    if (storedToken.expiresAt < new Date()) {
      await this.prisma.refreshToken.delete({ where: { token: refreshToken } });
      throw new UnauthorizedException(
        'Refresh token expired. Please login again',
      );
    }

    try {
      this.jwt.verify(refreshToken, { secret: process.env.JWT_REFRESH_SECRET });
    } catch {
      await this.prisma.refreshToken.delete({ where: { token: refreshToken } });
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.delete({ where: { token: refreshToken } });

    const tokens = await this.generateTokens(
      storedToken.user.id,
      storedToken.user.email,
      storedToken.user.role,
    );

    return {
      message: 'Token refreshed successfully',
      ...tokens,
    };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      return {
        message: 'If this email exists, a password reset link has been sent',
      };
    }

    // Invalidate existing tokens
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const resetToken = await bcrypt.hash(rawToken, 10);

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        email: user.email,
        token: resetToken,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const url = `${process.env.CLIENT_URL}/reset-password?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(user.email)}`;
    await this.mail.sendForgotPasswordEmail({
      email: user.email,
      firstName: user.firstName,
      url,
    });

    return {
      message: 'If this email exists, a password reset link has been sent',
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const record = await this.prisma.passwordResetToken.findFirst({
      where: { email: dto.email, used: false },
    });

    if (!record) throw new BadRequestException('Invalid reset token');
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('Reset token has expired');
    }

    const isValid = await bcrypt.compare(dto.token, record.token);
    if (!isValid) throw new BadRequestException('Invalid reset token');

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId! },
        data: { password: hashedPassword },
      });

      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { used: true },
      });

      // Force re-login on all devices
      await tx.refreshToken.deleteMany({
        where: { userId: record.userId! },
      });
    });

    return {
      message: 'Password reset successful. Please login with your new password',
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const passwordMatch = await bcrypt.compare(
      dto.currentPassword,
      user.password,
    );
    if (!passwordMatch)
      throw new BadRequestException('Current password is incorrect');

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'New password must be different from current password',
      );
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      await tx.refreshToken.deleteMany({ where: { userId } });
    });

    return { message: 'Password changed successfully. Please login again' };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    // console.log(dto.token, dto.email);
    const record = await this.prisma.emailVerificationToken.findFirst({
      where: { email: dto.email, used: false },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
          },
        },
      },
    });
    
    if (!record) throw new BadRequestException('Invalid verification token');
    if (!record.user) throw new BadRequestException('User not found');
    if (record.expiresAt < new Date()) {
      throw new BadRequestException(
        'Verification token has expired. Please request a new one',
      );
    }

    const isValid = await bcrypt.compare(dto.token, record.token);
    if (!isValid)
      throw new BadRequestException(
        'Invalid verification token from this angle',
      );

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId! },
        data: { isEmailVerified: true },
      });

      await tx.emailVerificationToken.update({
        where: { id: record.id },
        data: { used: true },
      });
    });


    await this.mail.sendWelcomeEmail({
      email: record.email,
      firstName: record.user.firstName
    })

    return { message: 'Email verified successfully. You can now login' };
  }

  async resendVerification(dto: ResendVerificationDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      return {
        message: 'If this email exists, a verification link has been sent',
      };
    }

    if (user.isEmailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    await this.prisma.emailVerificationToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const emailToken = await bcrypt.hash(rawToken, 10);

    await this.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        email: user.email,
        token: emailToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const url = `${process.env.CLIENT_URL}/verify-email?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(user.email)}`;
    await this.mail.sendVerificationEmail({
      email: dto.email,
      firstName: user.firstName,
      url,
    });

    return {
      message: 'If this email exists, a verification link has been sent',
      rawToken,
      email: dto.email,
    };
  }

  async generateTokens(userId: string, email: string, role: string) {
    const payload = { sub: userId, email, role };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: process.env.JWT_SECRET,
        expiresIn: '1d',
      }),
      this.jwt.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: '7d',
      }),
    ]);

    await this.prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken, refreshToken };
  }
}
