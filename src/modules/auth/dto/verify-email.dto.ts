import { IsEmail, IsString, IsNotEmpty } from 'class-validator';

export class VerifyEmailDto {
  @IsString()
  @IsNotEmpty({ message: 'Token is required' })
  token: string;

  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;
}